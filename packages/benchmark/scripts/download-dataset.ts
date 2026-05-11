#!/usr/bin/env tsx
import { ensureDataset } from "../src/dataset.js";

const force = process.argv.includes("--force");
const rows = await ensureDataset(force);
process.stdout.write(`cached ${rows.length} rows\n`);
