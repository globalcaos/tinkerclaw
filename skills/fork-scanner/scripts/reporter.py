"""
Reporter module for generating analysis reports
"""
import logging
import json
import csv
from datetime import datetime
from pathlib import Path
from typing import Dict, List

from config import REPORT_CONFIG, UPSTREAM_REPO
from database import Database

logger = logging.getLogger(__name__)


class Reporter:
    """Generates reports from analysis results"""
    
    def __init__(self, db: Database):
        self.db = db
        self.output_dir = REPORT_CONFIG['output_dir']
        self.top_n = REPORT_CONFIG['top_n_forks']
    
    def generate_all_reports(self, run_stats: Dict = None):
        """Generate all configured report formats"""
        logger.info("=" * 60)
        logger.info("GENERATING REPORTS")
        logger.info("=" * 60)
        
        timestamp = datetime.utcnow().strftime('%Y%m%d_%H%M%S')
        
        # Generate Markdown report
        md_path = self.output_dir / f'report_{timestamp}.md'
        self.generate_markdown_report(md_path, run_stats)
        logger.info(f"✓ Markdown report: {md_path}")
        
        # Generate CSV export
        if REPORT_CONFIG['generate_csv']:
            csv_path = self.output_dir / f'forks_{timestamp}.csv'
            self.generate_csv_export(csv_path)
            logger.info(f"✓ CSV export: {csv_path}")
        
        # Generate JSON export
        if REPORT_CONFIG['generate_json']:
            json_path = self.output_dir / f'data_{timestamp}.json'
            self.generate_json_export(json_path)
            logger.info(f"✓ JSON export: {json_path}")
        
        # Generate PDF (if enabled)
        if REPORT_CONFIG['generate_pdf']:
            try:
                pdf_path = self.output_dir / f'report_{timestamp}.pdf'
                self._convert_md_to_pdf(md_path, pdf_path)
                logger.info(f"✓ PDF report: {pdf_path}")
            except Exception as e:
                logger.warning(f"Failed to generate PDF: {e}")
        
        logger.info(f"\nReports generated in: {self.output_dir}")
    
    def generate_markdown_report(self, output_path: Path, run_stats: Dict = None):
        """Generate comprehensive Markdown report"""
        stats = self.db.get_statistics()
        top_forks = self.db.get_top_forks_for_tier3(self.top_n)
        all_gems = self.db.get_all_gems()
        watchlist = self.db.get_watchlist()
        
        with open(output_path, 'w') as f:
            # Header
            f.write(f"# GitHub Fork Analysis Report\n\n")
            f.write(f"**Repository:** {UPSTREAM_REPO}\n\n")
            f.write(f"**Generated:** {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')} UTC\n\n")
            f.write(f"---\n\n")
            
            # Executive Summary
            f.write(f"## Executive Summary\n\n")
            f.write(f"This report presents the results of analyzing **{stats['total_forks']:,}** forks ")
            f.write(f"of the {UPSTREAM_REPO} repository using a three-tier funnel strategy.\n\n")
            
            # Overall Statistics
            f.write(f"## Overall Statistics\n\n")
            f.write(f"| Metric | Value |\n")
            f.write(f"|--------|-------|\n")
            f.write(f"| Total Forks Analyzed | {stats['total_forks']:,} |\n")
            f.write(f"| Forks in Tier 1 | {stats['forks_by_tier'].get(1, 0):,} |\n")
            f.write(f"| Forks in Tier 2 | {stats['forks_by_tier'].get(2, 0):,} |\n")
            f.write(f"| Forks in Tier 3 | {stats['forks_by_tier'].get(3, 0):,} |\n")
            f.write(f"| Total Commits Analyzed | {stats['total_commits']:,} |\n")
            f.write(f"| Total Gems Found | {stats['total_gems']:,} |\n")
            f.write(f"| Forks on Watchlist | {stats['watchlist_size']:,} |\n")
            f.write(f"\n")
            
            # Gems by Category
            if stats['gems_by_category']:
                f.write(f"### Gems by Category\n\n")
                f.write(f"| Category | Count |\n")
                f.write(f"|----------|-------|\n")
                for category, count in sorted(stats['gems_by_category'].items(), key=lambda x: x[1], reverse=True):
                    f.write(f"| {category.title()} | {count} |\n")
                f.write(f"\n")
            
            # Run Statistics (if provided)
            if run_stats:
                f.write(f"## Run Statistics\n\n")
                f.write(f"| Tier | Forks Processed | Duration |\n")
                f.write(f"|------|-----------------|----------|\n")
                for tier, data in run_stats.items():
                    f.write(f"| {tier} | {data.get('count', 0):,} | {data.get('duration', 'N/A')} |\n")
                f.write(f"\n")
            
            # Top Forks
            f.write(f"## Top {self.top_n} Forks by Score\n\n")
            f.write(f"| Rank | Fork | Score | Stars | Commits Ahead | Last Updated |\n")
            f.write(f"|------|------|-------|-------|---------------|-------------|\n")
            
            for i, fork in enumerate(top_forks, 1):
                pushed_at = fork.get('pushed_at', 'N/A')
                if pushed_at != 'N/A':
                    pushed_at = pushed_at[:10]  # Just the date
                
                f.write(f"| {i} | [{fork['full_name']}](https://github.com/{fork['full_name']}) | "
                       f"{fork['score']:,} | {fork['stars']} | {fork.get('commits_ahead', 0)} | {pushed_at} |\n")
            f.write(f"\n")
            
            # Discovered Gems
            if all_gems:
                f.write(f"## Discovered Gems\n\n")
                
                # Group by category
                gems_by_category = {}
                for gem in all_gems:
                    category = gem['category']
                    if category not in gems_by_category:
                        gems_by_category[category] = []
                    gems_by_category[category].append(gem)
                
                for category, gems in sorted(gems_by_category.items()):
                    f.write(f"### {category.title()} ({len(gems)} gems)\n\n")
                    
                    for gem in gems[:10]:  # Show top 10 per category
                        f.write(f"#### {gem['full_name']}\n\n")
                        f.write(f"**Description:** {gem['description']}\n\n")
                        f.write(f"**Diff Summary:** {gem['diff_summary']}\n\n")
                        f.write(f"**Repository:** https://github.com/{gem['full_name']}\n\n")
                        f.write(f"---\n\n")
                    
                    if len(gems) > 10:
                        f.write(f"*... and {len(gems) - 10} more {category} gems*\n\n")
            
            # Watchlist
            if watchlist:
                f.write(f"## Watchlist ({len(watchlist)} forks)\n\n")
                f.write(f"| Priority | Fork | Score | Stars | Reason |\n")
                f.write(f"|----------|------|-------|-------|--------|\n")
                
                for item in watchlist:
                    f.write(f"| {item['priority']} | [{item['full_name']}](https://github.com/{item['full_name']}) | "
                           f"{item['score']:,} | {item['stars']} | {item['reason']} |\n")
                f.write(f"\n")
            
            # Recommendations
            f.write(f"## Recommendations\n\n")
            
            if stats['total_gems'] > 0:
                f.write(f"Based on the analysis, we recommend reviewing the following:\n\n")
                f.write(f"1. **Security Gems**: Prioritize reviewing {stats['gems_by_category'].get('security', 0)} security-related changes\n")
                f.write(f"2. **Feature Additions**: Evaluate {stats['gems_by_category'].get('feature', 0)} new features for potential integration\n")
                f.write(f"3. **Optimizations**: Consider {stats['gems_by_category'].get('optimization', 0)} performance improvements\n")
                f.write(f"4. **Bug Fixes**: Review {stats['gems_by_category'].get('fix', 0)} bug fixes for applicability\n\n")
            else:
                f.write(f"No significant gems were found in this analysis run. Consider:\n\n")
                f.write(f"1. Adjusting the scoring keywords to better match the project domain\n")
                f.write(f"2. Lowering the Tier 3 threshold to analyze more forks\n")
                f.write(f"3. Running the analysis again after more time has passed\n\n")
            
            # Footer
            f.write(f"---\n\n")
            f.write(f"*Generated by GitHub Fork Analysis System*\n")
    
    def generate_csv_export(self, output_path: Path):
        """Export fork rankings to CSV"""
        forks = self.db.get_all_forks()
        
        with open(output_path, 'w', newline='') as f:
            writer = csv.writer(f)
            
            # Header
            writer.writerow(['Rank', 'Full Name', 'Score', 'Stars', 'Commits Ahead', 
                           'Commits Behind', 'Tier', 'Pushed At', 'GitHub URL'])
            
            # Data
            for i, fork in enumerate(forks, 1):
                writer.writerow([
                    i,
                    fork['full_name'],
                    fork['score'],
                    fork['stars'],
                    fork.get('commits_ahead', 0),
                    fork.get('commits_behind', 0),
                    fork.get('tier', 0),
                    fork.get('pushed_at', ''),
                    f"https://github.com/{fork['full_name']}"
                ])
    
    def generate_json_export(self, output_path: Path):
        """Export complete data to JSON"""
        data = {
            'generated_at': datetime.utcnow().isoformat(),
            'repository': UPSTREAM_REPO,
            'statistics': self.db.get_statistics(),
            'forks': self.db.get_all_forks(),
            'gems': self.db.get_all_gems(),
            'watchlist': self.db.get_watchlist(),
        }
        
        with open(output_path, 'w') as f:
            json.dump(data, f, indent=2, default=str)
    
    def _convert_md_to_pdf(self, md_path: Path, pdf_path: Path):
        """Convert Markdown to PDF using weasyprint"""
        try:
            import markdown
            from weasyprint import HTML
            
            # Read markdown
            with open(md_path, 'r') as f:
                md_content = f.read()
            
            # Convert to HTML
            html_content = markdown.markdown(md_content, extensions=['tables', 'fenced_code'])
            
            # Add CSS styling
            styled_html = f"""
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <style>
                    body {{
                        font-family: Arial, sans-serif;
                        line-height: 1.6;
                        max-width: 800px;
                        margin: 40px auto;
                        padding: 0 20px;
                    }}
                    table {{
                        border-collapse: collapse;
                        width: 100%;
                        margin: 20px 0;
                    }}
                    th, td {{
                        border: 1px solid #ddd;
                        padding: 8px;
                        text-align: left;
                    }}
                    th {{
                        background-color: #f2f2f2;
                    }}
                    h1, h2, h3 {{
                        color: #333;
                    }}
                    code {{
                        background-color: #f4f4f4;
                        padding: 2px 4px;
                        border-radius: 3px;
                    }}
                </style>
            </head>
            <body>
                {html_content}
            </body>
            </html>
            """
            
            # Convert to PDF
            HTML(string=styled_html).write_pdf(pdf_path)
            
        except ImportError:
            logger.warning("weasyprint or markdown not available, skipping PDF generation")
        except Exception as e:
            logger.error(f"Error converting to PDF: {e}")
            raise
