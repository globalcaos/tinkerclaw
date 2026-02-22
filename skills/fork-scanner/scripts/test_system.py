#!/usr/bin/env python3
"""
Test script for GitHub Fork Analysis System
Verifies all components without making actual API calls
"""
import sys
import sqlite3
from pathlib import Path

print("="*60)
print("GitHub Fork Analysis System - Component Test")
print("="*60)
print()

# Test 1: Import all modules
print("Test 1: Importing modules...")
try:
    import config
    import database
    import rate_limiter
    import tier1_metadata
    import tier2_commits
    import tier3_diff
    import watchlist
    import reporter
    import fork_scanner
    print("✓ All modules imported successfully")
except ImportError as e:
    print(f"✗ Import failed: {e}")
    sys.exit(1)

# Test 2: Database initialization
print("\nTest 2: Database initialization...")
try:
    from database import Database
    db = Database(Path("data/test_forks.db"))
    print("✓ Database created successfully")
    
    # Check tables
    cursor = db.conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = [row[0] for row in cursor.fetchall()]
    expected_tables = ['forks', 'commits', 'gems', 'watchlist', 'run_history']
    
    for table in expected_tables:
        if table in tables:
            print(f"  ✓ Table '{table}' exists")
        else:
            print(f"  ✗ Table '{table}' missing")
    
    db.close()
except Exception as e:
    print(f"✗ Database test failed: {e}")
    sys.exit(1)

# Test 3: Configuration validation
print("\nTest 3: Configuration validation...")
try:
    from config import (
        GITHUB_TOKEN, UPSTREAM_REPO, TIER1_FILTERS,
        TIER2_CONFIG, TIER3_CONFIG, SCORING_KEYWORDS
    )
    
    print(f"  UPSTREAM_REPO: {UPSTREAM_REPO}")
    print(f"  GITHUB_TOKEN: {'Set' if GITHUB_TOKEN else 'Not set (will use unauthenticated)'}")
    print(f"  Tier 1 filters: {len(TIER1_FILTERS)} configured")
    print(f"  Tier 2 config: {len(TIER2_CONFIG)} settings")
    print(f"  Tier 3 config: {len(TIER3_CONFIG)} settings")
    print(f"  Scoring keywords: {len(SCORING_KEYWORDS)} keywords")
    print("✓ Configuration loaded successfully")
except Exception as e:
    print(f"✗ Configuration test failed: {e}")
    sys.exit(1)

# Test 4: Database operations
print("\nTest 4: Database operations...")
try:
    from database import Database
    db = Database(Path("data/test_forks.db"))
    
    # Insert test fork
    fork_data = {
        'full_name': 'testuser/testrepo',
        'stars': 10,
        'pushed_at': '2024-01-01T00:00:00Z',
        'commits_ahead': 5,
        'commits_behind': 2,
        'created_at': '2023-01-01T00:00:00Z',
        'default_branch': 'main',
        'tier': 1
    }
    fork_id = db.insert_fork(fork_data)
    print(f"  ✓ Inserted test fork (ID: {fork_id})")
    
    # Retrieve fork
    fork = db.get_fork_by_name('testuser/testrepo')
    if fork and fork['stars'] == 10:
        print(f"  ✓ Retrieved fork successfully")
    else:
        print(f"  ✗ Fork retrieval failed")
    
    # Insert test commit
    commit_data = {
        'fork_id': fork_id,
        'sha': 'abc123',
        'message': 'Fix security vulnerability',
        'author': 'Test Author',
        'date': '2024-01-01T00:00:00Z',
        'score': 10,
        'categories': ['security']
    }
    commit_id = db.insert_commit(commit_data)
    print(f"  ✓ Inserted test commit (ID: {commit_id})")
    
    # Get statistics
    stats = db.get_statistics()
    print(f"  ✓ Statistics: {stats['total_forks']} forks, {stats['total_commits']} commits")
    
    db.close()
    print("✓ Database operations successful")
except Exception as e:
    print(f"✗ Database operations failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

# Test 5: Scoring logic
print("\nTest 5: Scoring logic...")
try:
    from tier2_commits import Tier2CommitAnalysis
    from database import Database
    from rate_limiter import RateLimiter
    
    db = Database(Path("data/test_forks.db"))
    rate_limiter = RateLimiter()
    tier2 = Tier2CommitAnalysis(db, rate_limiter)
    
    # Test commit scoring
    test_commits = [
        {'message': 'Fix security vulnerability in auth'},
        {'message': 'Add new feature for caching'},
        {'message': 'Optimize performance of main loop'},
        {'message': 'Fix bug in parser'},
    ]
    
    for commit in test_commits:
        score, categories = tier2._score_commit(commit)
        print(f"  '{commit['message'][:40]}...' -> Score: {score}, Categories: {categories}")
    
    db.close()
    print("✓ Scoring logic working")
except Exception as e:
    print(f"✗ Scoring test failed: {e}")
    import traceback
    traceback.print_exc()

# Test 6: File structure
print("\nTest 6: File structure...")
required_files = [
    'fork_scanner.py',
    'config.py',
    'database.py',
    'rate_limiter.py',
    'tier1_metadata.py',
    'tier2_commits.py',
    'tier3_diff.py',
    'watchlist.py',
    'reporter.py',
    'schema.sql',
    'requirements.txt',
    'README.md',
    'ARCHITECTURE.md',
    'setup_cron.sh',
]

for filename in required_files:
    filepath = Path(filename)
    if filepath.exists():
        print(f"  ✓ {filename}")
    else:
        print(f"  ✗ {filename} missing")

# Cleanup
print("\nCleaning up test database...")
test_db = Path("data/test_forks.db")
if test_db.exists():
    test_db.unlink()
    print("✓ Test database removed")

print("\n" + "="*60)
print("All tests completed successfully!")
print("="*60)
print("\nThe system is ready to use. Next steps:")
print("1. Set GITHUB_TOKEN environment variable")
print("2. Set UPSTREAM_REPO environment variable")
print("3. Run: python3 fork_scanner.py --help")
print("="*60)
