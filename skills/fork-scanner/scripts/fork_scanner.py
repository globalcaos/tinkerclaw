#!/usr/bin/env python3
"""
GitHub Fork Analysis System - Main Script

Analyzes GitHub forks using a three-tier funnel strategy:
- Tier 1: Metadata filtering
- Tier 2: Commit analysis
- Tier 3: Deep diff analysis

Usage:
    python fork_scanner.py [options]

Options:
    --tier1-only        Run only Tier 1 (metadata filter)
    --tier2-only        Run only Tier 2 (commit analysis)
    --tier3-only        Run only Tier 3 (diff analysis)
    --update-watchlist  Update watchlist after analysis
    --no-report         Skip report generation
    --help              Show this help message
"""
import sys
import logging
import argparse
from datetime import datetime
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from config import LOGGING_CONFIG, TIER2_CONFIG
from database import Database
from rate_limiter import RateLimiter
from tier1_metadata import Tier1MetadataFilter
from tier2_commits import Tier2CommitAnalysis
from tier3_diff import Tier3DiffAnalysis
from watchlist import WatchlistManager
from reporter import Reporter


def setup_logging():
    """Configure logging"""
    logging.basicConfig(
        level=getattr(logging, LOGGING_CONFIG['level']),
        format=LOGGING_CONFIG['format'],
        handlers=[
            logging.FileHandler(LOGGING_CONFIG['log_file']),
            logging.StreamHandler(sys.stdout)
        ]
    )


def parse_arguments():
    """Parse command line arguments"""
    parser = argparse.ArgumentParser(
        description='GitHub Fork Analysis System',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    
    parser.add_argument('--tier1-only', action='store_true',
                       help='Run only Tier 1 (metadata filter)')
    parser.add_argument('--tier2-only', action='store_true',
                       help='Run only Tier 2 (commit analysis)')
    parser.add_argument('--tier3-only', action='store_true',
                       help='Run only Tier 3 (diff analysis)')
    parser.add_argument('--update-watchlist', action='store_true',
                       help='Update watchlist after analysis')
    parser.add_argument('--no-report', action='store_true',
                       help='Skip report generation')
    parser.add_argument('--show-watchlist', action='store_true',
                       help='Show current watchlist and exit')
    parser.add_argument('--add-to-watchlist', metavar='FORK_NAME',
                       help='Add fork to watchlist (format: owner/repo)')
    parser.add_argument('--remove-from-watchlist', metavar='FORK_NAME',
                       help='Remove fork from watchlist')
    parser.add_argument('--watchlist-reason', metavar='REASON',
                       help='Reason for adding to watchlist (use with --add-to-watchlist)')
    parser.add_argument('--watchlist-priority', type=int, default=5,
                       help='Priority for watchlist entry (1-10, default: 5)')
    
    return parser.parse_args()


def main():
    """Main execution function"""
    # Setup
    setup_logging()
    logger = logging.getLogger(__name__)
    
    logger.info("="*80)
    logger.info("GITHUB FORK ANALYSIS SYSTEM")
    logger.info("="*80)
    logger.info(f"Started at: {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')} UTC\n")
    
    # Parse arguments
    args = parse_arguments()
    
    # Initialize components
    db = Database()
    rate_limiter = RateLimiter()
    watchlist_manager = WatchlistManager(db)
    
    try:
        # Handle watchlist commands
        if args.show_watchlist:
            watchlist_manager.print_watchlist()
            return 0
        
        if args.add_to_watchlist:
            reason = args.watchlist_reason or "Manually added"
            success = watchlist_manager.add_manual(
                args.add_to_watchlist,
                reason,
                args.watchlist_priority
            )
            return 0 if success else 1
        
        if args.remove_from_watchlist:
            success = watchlist_manager.remove(args.remove_from_watchlist)
            return 0 if success else 1
        
        # Determine which tiers to run
        run_tier1 = not (args.tier2_only or args.tier3_only)
        run_tier2 = not (args.tier1_only or args.tier3_only)
        run_tier3 = not (args.tier1_only or args.tier2_only)
        
        # Track statistics
        run_stats = {}
        start_time = datetime.utcnow()
        
        # TIER 1: Metadata Filter
        if run_tier1:
            tier1_start = datetime.utcnow()
            run_id = db.start_run(tier=1)
            
            try:
                tier1 = Tier1MetadataFilter(db, rate_limiter)
                tier1_count = tier1.run()
                
                tier1_duration = datetime.utcnow() - tier1_start
                run_stats['Tier 1'] = {
                    'count': tier1_count,
                    'duration': str(tier1_duration).split('.')[0]
                }
                
                db.complete_run(run_id, tier1_count, 0, 'success')
                
            except Exception as e:
                logger.error(f"Tier 1 failed: {e}", exc_info=True)
                db.complete_run(run_id, 0, 0, 'failed', str(e))
                raise
        
        # TIER 2: Commit Analysis
        if run_tier2:
            tier2_start = datetime.utcnow()
            run_id = db.start_run(tier=2)
            
            try:
                tier2 = Tier2CommitAnalysis(db, rate_limiter)
                tier2_count = tier2.run()
                
                tier2_duration = datetime.utcnow() - tier2_start
                run_stats['Tier 2'] = {
                    'count': tier2_count,
                    'duration': str(tier2_duration).split('.')[0]
                }
                
                db.complete_run(run_id, tier2_count, 0, 'success')
                
            except Exception as e:
                logger.error(f"Tier 2 failed: {e}", exc_info=True)
                db.complete_run(run_id, 0, 0, 'failed', str(e))
                raise
        
        # TIER 3: Diff Analysis
        if run_tier3:
            tier3_start = datetime.utcnow()
            run_id = db.start_run(tier=3)
            
            try:
                # Get top forks for Tier 3
                top_forks = db.get_top_forks_for_tier3(TIER2_CONFIG['top_n_for_tier3'])
                
                tier3 = Tier3DiffAnalysis(db)
                gems_count = tier3.run(top_forks)
                
                tier3_duration = datetime.utcnow() - tier3_start
                run_stats['Tier 3'] = {
                    'count': len(top_forks),
                    'duration': str(tier3_duration).split('.')[0]
                }
                
                db.complete_run(run_id, len(top_forks), gems_count, 'success')
                
            except Exception as e:
                logger.error(f"Tier 3 failed: {e}", exc_info=True)
                db.complete_run(run_id, 0, 0, 'failed', str(e))
                raise
        
        # Update Watchlist
        if args.update_watchlist or run_tier3:
            watchlist_manager.update_watchlist()
        
        # Generate Reports
        if not args.no_report:
            reporter = Reporter(db)
            reporter.generate_all_reports(run_stats)
        
        # Print summary
        total_duration = datetime.utcnow() - start_time
        logger.info("\n" + "="*80)
        logger.info("ANALYSIS COMPLETE")
        logger.info("="*80)
        logger.info(f"Total duration: {str(total_duration).split('.')[0]}")
        
        # Print statistics
        stats = db.get_statistics()
        logger.info(f"\nFinal Statistics:")
        logger.info(f"  Total forks: {stats['total_forks']:,}")
        logger.info(f"  Total commits analyzed: {stats['total_commits']:,}")
        logger.info(f"  Total gems found: {stats['total_gems']:,}")
        logger.info(f"  Watchlist size: {stats['watchlist_size']:,}")
        
        if stats['top_fork']:
            logger.info(f"  Top fork: {stats['top_fork']['full_name']} (score: {stats['top_fork']['score']:,})")
        
        logger.info("\n" + "="*80)
        
        return 0
        
    except KeyboardInterrupt:
        logger.warning("\nInterrupted by user")
        return 130
    
    except Exception as e:
        logger.error(f"\nFatal error: {e}", exc_info=True)
        return 1
    
    finally:
        db.close()


if __name__ == '__main__':
    sys.exit(main())
