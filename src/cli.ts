#!/usr/bin/env node

import { Command } from 'commander';
import { SqliteStorage } from './storage/sqlite.js';
import { handleVerifyStatus, handleGenerateHarness } from './verification/cliHandler.js';
import * as path from 'path';

const program = new Command();

program
  .name('prism')
  .description('Prism Configuration & CLI')
  .version('7.3.1');

const verifyCmd = program
  .command('verify')
  .description('Manage the verification harness');

verifyCmd
  .command('status')
  .description('Check the current verification state and view config drift')
  .option('-p, --project <name>', 'Project name', path.basename(process.cwd()))
  .option('-f, --force', 'Bypass verification failures and drift tracking constraints')
  .option('-u, --user <id>', 'User ID for tenant isolation', 'default')
  .action(async (options) => {
    const storage = new SqliteStorage();
    await storage.initialize('./prism-local.db');
    
    // H4 fix: Ensure storage is closed on exit to flush WAL and prevent data loss
    try {
      await handleVerifyStatus(storage, options.project, !!options.force, options.user);
    } finally {
      await storage.close();
    }
  });

verifyCmd
  .command('generate')
  .description('Bless the current ./verification_harness.json as the canonical rubric')
  .option('-p, --project <name>', 'Project name', path.basename(process.cwd()))
  .option('-f, --force', 'Bypass verification failures and drift tracking constraints')
  .option('-u, --user <id>', 'User ID for tenant isolation', 'default')
  .action(async (options) => {
    const storage = new SqliteStorage();
    await storage.initialize('./prism-local.db');
    
    // H4 fix: Ensure storage is closed on exit to flush WAL and prevent data loss
    try {
      await handleGenerateHarness(storage, options.project, !!options.force, options.user);
    } finally {
      await storage.close();
    }
  });

program.parse(process.argv);
