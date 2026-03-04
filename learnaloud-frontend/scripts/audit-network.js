#!/usr/bin/env node

/**
 * Network Audit Script
 *
 * Verifies that pages make only expected network calls.
 * Critical check: Landing page should make ZERO backend calls before user intent.
 *
 * Usage: node scripts/audit-network.js
 * Output: scripts/network-audit-report.txt
 */

const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4200';
const REPORT_PATH = path.join(__dirname, 'network-audit-report.txt');

// Pages to audit
const PAGES_TO_AUDIT = [
  {
    path: '/',
    name: 'Landing',
    ctaSelector: 'button:has-text("Upload"), label:has-text("Upload"), .upload-btn',
    ctaDescription: 'Upload your PDF',
  },
  {
    path: '/library',
    name: 'Library',
    ctaSelector: '.dropzone, .document-card',
    ctaDescription: 'dropzone or first document card',
  },
  {
    path: '/settings',
    name: 'Settings',
    ctaSelector: '.toggle-btn:has-text("Often"), .nav-item',
    ctaDescription: 'quiz frequency toggle',
  },
];

// Check if a URL is a backend/API call
function isBackendCall(url) {
  const urlLower = url.toLowerCase();

  // Exclude Vite dev server internal requests
  if (urlLower.includes('/@fs/') || urlLower.includes('/@vite/')) {
    return false;
  }

  // Exclude static assets
  if (urlLower.match(/\.(js|css|png|jpg|svg|woff|woff2|ttf|ico)(\?|$)/)) {
    return false;
  }

  return (
    urlLower.includes('/api/') ||
    urlLower.includes('/api?') ||
    (urlLower.includes('livekit') && !urlLower.includes('node_modules')) ||
    urlLower.includes('.livekit.cloud') ||
    urlLower.includes('socket.io') ||
    (urlLower.includes('websocket') && !urlLower.includes('/@'))
  );
}

// Categorize request
function categorizeRequest(url) {
  if (url.includes('/api/')) return 'API';
  if (url.includes('livekit')) return 'LiveKit';
  if (url.includes('socket.io')) return 'Socket.IO';
  if (url.includes('websocket')) return 'WebSocket';
  return 'Other';
}

// Format request for report
function formatRequest(req) {
  const method = req.method();
  const url = req.url();
  const category = categorizeRequest(url);

  // Shorten URL for readability
  let shortUrl = url;
  try {
    const parsed = new URL(url);
    shortUrl = parsed.pathname + parsed.search;
    if (shortUrl.length > 80) {
      shortUrl = shortUrl.substring(0, 77) + '...';
    }
  } catch (e) {
    // Keep original if parsing fails
  }

  return `${method} ${shortUrl} [${category}]`;
}

async function auditPage(browser, pageConfig) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  const onLoadRequests = [];
  const afterClickRequests = [];
  let isAfterClick = false;

  // Intercept all requests
  page.on('request', (request) => {
    const url = request.url();

    // Skip browser internal requests
    if (url.startsWith('data:') || url.startsWith('blob:')) return;

    // Only track backend calls for the report
    if (isBackendCall(url)) {
      if (isAfterClick) {
        afterClickRequests.push(request);
      } else {
        onLoadRequests.push(request);
      }
    }
  });

  // Navigate to page
  console.log(`  Loading ${pageConfig.path}...`);
  try {
    await page.goto(BASE_URL + pageConfig.path, {
      waitUntil: 'networkidle',
      timeout: 30000
    });
  } catch (e) {
    console.log(`  Warning: Page load timeout or error: ${e.message}`);
  }

  // Wait 5 seconds with no interaction
  await page.waitForTimeout(5000);

  // Mark that we're now after the click
  isAfterClick = true;

  // Try to click the primary CTA
  let ctaClicked = false;
  let ctaDescription = pageConfig.ctaDescription;

  if (pageConfig.ctaSelector) {
    try {
      const cta = page.locator(pageConfig.ctaSelector).first();
      if (await cta.count() > 0 && await cta.isVisible()) {
        await cta.click({ timeout: 2000 });
        ctaClicked = true;
        console.log(`  Clicked: ${ctaDescription}`);
      }
    } catch (e) {
      console.log(`  Could not click CTA: ${e.message}`);
    }
  }

  // Wait 2 more seconds after click
  if (ctaClicked) {
    await page.waitForTimeout(2000);
  }

  await context.close();

  return {
    page: pageConfig,
    onLoadRequests,
    afterClickRequests,
    ctaClicked,
    ctaDescription,
  };
}

async function generateReport(results) {
  const lines = [];
  const timestamp = new Date().toISOString();

  lines.push('=' .repeat(70));
  lines.push('NETWORK AUDIT REPORT');
  lines.push(`Generated: ${timestamp}`);
  lines.push(`Base URL: ${BASE_URL}`);
  lines.push('=' .repeat(70));
  lines.push('');

  let hasIssues = false;

  for (const result of results) {
    lines.push('-'.repeat(70));
    lines.push(`PAGE: ${result.page.path} (${result.page.name})`);
    lines.push('-'.repeat(70));
    lines.push('');

    // On load requests
    lines.push('On load (0 interactions):');
    if (result.onLoadRequests.length === 0) {
      lines.push('  [none]');
      if (result.page.path === '/') {
        lines.push('  ✓ PASS: No backend calls on landing page load');
      }
    } else {
      for (const req of result.onLoadRequests) {
        lines.push(`  ${formatRequest(req)}`);
      }

      // Flag if landing page made API calls
      if (result.page.path === '/') {
        lines.push('');
        lines.push('  ✗ FAIL: Landing page should not make backend calls on load!');
        hasIssues = true;
      }
    }
    lines.push('');

    // After click requests
    if (result.ctaClicked) {
      lines.push(`After clicking "${result.ctaDescription}":`);
      if (result.afterClickRequests.length === 0) {
        lines.push('  [none]');
      } else {
        for (const req of result.afterClickRequests) {
          lines.push(`  ${formatRequest(req)}`);
        }
      }
    } else {
      lines.push(`After click (no CTA found/clicked):`);
      lines.push('  [skipped]');
    }
    lines.push('');
  }

  // Summary
  lines.push('='.repeat(70));
  lines.push('SUMMARY');
  lines.push('='.repeat(70));
  lines.push('');

  for (const result of results) {
    const loadCount = result.onLoadRequests.length;
    const clickCount = result.afterClickRequests.length;
    const status = (result.page.path === '/' && loadCount > 0) ? '✗' : '✓';
    lines.push(`${status} ${result.page.path}: ${loadCount} calls on load, ${clickCount} calls after CTA`);
  }

  lines.push('');
  if (hasIssues) {
    lines.push('STATUS: ISSUES FOUND - Review the report above');
  } else {
    lines.push('STATUS: ALL CHECKS PASSED');
  }
  lines.push('');

  // Expected behavior note
  lines.push('-'.repeat(70));
  lines.push('EXPECTED BEHAVIOR:');
  lines.push('-'.repeat(70));
  lines.push('  /         : Zero API calls on load (demo is local/offline)');
  lines.push('  /library  : GET /api/documents on load (expected)');
  lines.push('  /settings : GET /api/users/me/settings on load (expected)');
  lines.push('');

  return lines.join('\n');
}

async function main() {
  console.log('Network Audit Script');
  console.log('====================');
  console.log(`Base URL: ${BASE_URL}`);
  console.log('');

  // Check if server is running
  console.log('Checking if server is running...');

  const browser = await chromium.launch({ headless: true });

  try {
    const testPage = await browser.newPage();
    await testPage.goto(BASE_URL, { timeout: 10000 });
    await testPage.close();
    console.log('Server is running.\n');
  } catch (e) {
    console.error(`ERROR: Could not connect to ${BASE_URL}`);
    console.error('Make sure the Angular dev server is running: npm start');
    await browser.close();
    process.exit(1);
  }

  const results = [];

  for (const pageConfig of PAGES_TO_AUDIT) {
    console.log(`\nAuditing: ${pageConfig.name} (${pageConfig.path})`);
    const result = await auditPage(browser, pageConfig);
    results.push(result);
  }

  await browser.close();

  // Generate and save report
  console.log('\nGenerating report...');
  const report = await generateReport(results);

  fs.writeFileSync(REPORT_PATH, report);
  console.log(`Report saved to: ${REPORT_PATH}`);

  // Also print to console
  console.log('\n');
  console.log(report);

  // Exit with error code if issues found
  const hasIssues = results.some(r => r.page.path === '/' && r.onLoadRequests.length > 0);
  process.exit(hasIssues ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
