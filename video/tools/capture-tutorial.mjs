// Captures the dark-theme screens for the tutorial screenplay that capture-screens.mjs does not cover:
// the custom-task questions, the Help sheets (route map, recipe steps) and the Shop.
// Usage: npm run tutorial-screens      (from video/)  -> video/screens/dark/tutorial/
import fs from 'node:fs';
import path from 'node:path';
import { startServer, openPhone, APP_PATH, REPO } from './lib.mjs';

const OUT = process.argv[2] || path.join(REPO, 'video/screens/dark/tutorial');
fs.mkdirSync(OUT, { recursive: true });

const server = await startServer();
const { browser, page: p } = await openPhone();

const shot = async (name, wait = 700) => { await p.waitForTimeout(wait); await p.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name); };

await p.goto(server.url + APP_PATH);
await p.waitForTimeout(1200);
await p.click('#demo-fill'); await p.waitForTimeout(1500);

// ---- Today ----
await shot('t01-today');

// ---- questions that build a custom task ----
await p.click('#fab-add'); await p.waitForTimeout(700);
await p.fill('#at-name', 'Go for a run');
await shot('t02-custom-questions');
await p.locator('#at-refine [data-rq=dist]').nth(1).click();           // 5 km
await p.locator('#at-refine [data-rq=pace]').nth(0).click();           // Easy
await shot('t03-custom-answered');
await p.click('#add-task-form button[type=submit]'); await p.waitForTimeout(1200);

// ---- hints: the Help sheet ----
const helpFor = async (name, shots) => {
  const card = p.locator('.task-card', { hasText: name }).first();
  await card.evaluate(e => e.scrollIntoView({ block: 'center' }));
  await card.locator('[data-help]').click(); await p.waitForTimeout(1500);
  await shots();
  await p.click('#btn-help-close'); await p.waitForTimeout(500);
};
await helpFor('Morning workout', () => shot('t04-help-gym-map'));
await helpFor('Go for a run', () => shot('t05-help-run-map'));
await helpFor('Cook dinner', async () => {
  await shot('t06-help-cook');
  await p.locator('#help-body .steps').evaluate(e => e.scrollIntoView({ block: 'center' }));
  await shot('t07-help-cook-steps');
});

// ---- shop ----
await p.click('.bn-item[data-view=shop]');
await shot('t08-shop-bail');
await p.locator('.shop-inv[data-shop-card="1"]').click();
await shot('t09-shop-retry', 1200);

await browser.close();
await server.close();
