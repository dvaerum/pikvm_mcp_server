/**
 * Quick test script for PiKVM client
 *
 * Run with: npx tsx test-client.ts
 */

import { PiKVMClient } from './src/pikvm/client.js';
import * as fs from 'fs';

async function main() {
  // Get config from environment or use defaults
  const host = process.env.PIKVM_HOST || 'https://192.168.1.71';
  const username = process.env.PIKVM_USERNAME || 'admin';
  const password = process.env.PIKVM_PASSWORD || 'admin';

  console.log(`Testing PiKVM client against ${host}`);

  const client = new PiKVMClient({
    host,
    username,
    password,
    verifySsl: false,
  });

  // Test 1: Check authentication
  console.log('\n1. Testing authentication...');
  const authOk = await client.checkAuth();
  console.log(`   Auth: ${authOk ? 'OK' : 'FAILED'}`);

  if (!authOk) {
    console.error('Authentication failed. Check credentials.');
    process.exit(1);
  }

  // Test 2: Get keymaps
  console.log('\n2. Getting available keymaps...');
  try {
    const keymaps = await client.getKeymaps();
    console.log(`   Keymaps: ${keymaps.slice(0, 5).join(', ')}...`);
  } catch (e) {
    console.log(`   Keymaps: Error - ${e}`);
  }

  // Test 3: Take screenshot
  console.log('\n3. Taking screenshot...');
  try {
    const screenshot = await client.screenshot({ maxWidth: 800, quality: 70 });
    const filename = 'test-screenshot.jpg';
    fs.writeFileSync(filename, screenshot);
    console.log(`   Screenshot saved to ${filename} (${screenshot.length} bytes)`);
  } catch (e) {
    console.log(`   Screenshot: Error - ${e}`);
  }

  // Test 4: Type text (commented out to avoid accidental input)
  // console.log('\n4. Typing test...');
  // await client.type('Hello from MCP!');

  console.log('\nAll tests completed!');
}

main().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});
