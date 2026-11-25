/* Actual checkout and server acceptance; synthetic transport, no public network. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium, webkit } = require('playwright');
const ccc = require('@ckb-ccc/core');
const root = path.resolve(__dirname, '../../..');
require(path.join(root, 'node_modules/ts-node')).register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: {
    module: 'CommonJS',
    target: 'ES2022',
    moduleResolution: 'node',
    verbatimModuleSyntax: false,
  },
});
const { OrderService } = require('../src/modules/direct/order-service.ts');
const { OrderMarkets } = require('../src/modules/direct/order-markets.ts');
const rollover = process.argv.includes('--rollover');
const demand = process.argv.includes('--demand') || rollover;
const { commitMarketRollovers } = require('../src/modules/direct/market-rollover.ts');
const {
  DirectRegistry,
  V5_DIRECT_CONFIG,
  V4_DIRECT_CONFIG,
  createRecord,
} = require('../src/modules/direct/registry.ts');
const { OperatorJournal } = require('../src/modules/direct/journal.ts');

async function main() {
  const { build } = await import('vite'),
    { Wallet } = await import('ethers');
  const { batchChain, batchOwnerKey, attachBatchRpc } = await import('./batch-browser-fixture.mjs');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'streak-orders-browser-'));
  const evidence = path.join(root, '.quality-artifacts/order-browser');
  fs.mkdirSync(evidence, { recursive: true });
  const source = (p) => JSON.stringify(path.join(__dirname, p).replaceAll('\\', '/'));
  fs.writeFileSync(
    path.join(temp, 'entry.jsx'),
    `
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {QueryClient,QueryClientProvider} from ${source('../node_modules/@tanstack/react-query/build/modern/index.js')};
 import {OrderCheckout,PaymentCheckout} from ${source('../web/src/features/direct/order-ui.tsx')};
 import {DraftStore} from ${source('../web/src/features/predictions/draft.ts')};
 import {getWalletState} from ${source('../web/src/lib/wallet.ts')};
 import {configureOrderManifest} from ${source('../web/src/features/direct/protocol.ts')};
 import {connect} from ${source('checkout-browser-wallet.mjs')};
 import ${source('../web/src/design-system/styles.css')};
 const fixture=window.fixture;configureOrderManifest(fixture.config);
 const store=new DraftStore(localStorage);window.connectTest=connect;window.checkoutDraft=()=>store.getSnapshot().draft;
 const qc=new QueryClient({defaultOptions:{queries:{retry:false}}});
 function App(){const [busy,setBusy]=useState(false),[target,setTarget]=useState(null),[feedback,setFeedback]=useState(null),[mount,setMount]=useState(0),[active,setActive]=useState(true),[,refreshCapability]=useState(0);
 window.remountCheckout=()=>setMount(n=>n+1);
 window.setSlipActive=setActive;
 window.setTestSignType=(signType)=>{Object.defineProperty(getWalletState().connection.signer,'signType',{value:signType,configurable:true});refreshCapability(n=>n+1);};
 return <main style={{maxWidth:600,margin:'auto',padding:20}}><h1>Queued predictions</h1>
 <button className="quiet" disabled={busy} onClick={()=>{for(const id of fixture.fixtureIds)store.select('market-'+id,id,'home')}}>Add next pick</button>
 <${demand ? 'PaymentCheckout' : 'OrderCheckout'} key={mount} store={store} account={{id:'order-browser-user',username:'Test manager',walletAddress:fixture.address}} accountReady={true} onSignIn={()=>{}} signInPending={false} active={active} onBusy={setBusy} activityTarget={target} feedbackTarget={feedback} config={fixture.config}/>
 <section aria-label="Payment feedback" ref={setFeedback}/><section aria-label="Saved payments" ref={setTarget}/></main>}
 createRoot(document.getElementById('root')).render(<QueryClientProvider client={qc}><App/></QueryClientProvider>);
 `,
  );
  fs.writeFileSync(
    path.join(temp, 'index.html'),
    '<div id="root"></div><script type="module" src="/entry.jsx"></script>',
  );
  await build({
    configFile: false,
    root: temp,
    logLevel: 'error',
    resolve: {
      alias: {
        react: path.join(__dirname, '../node_modules/react'),
        'react-dom': path.join(__dirname, '../node_modules/react-dom'),
      },
    },
    build: { outDir: path.join(temp, 'dist'), emptyOutDir: true },
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost'),
      file = path.resolve(
        temp,
        'dist',
        '.' + (url.pathname === '/' ? '/index.html' : url.pathname),
      );
    if (!file.startsWith(path.join(temp, 'dist') + path.sep) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader(
      'Content-Type',
      file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html',
    );
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    for (const [name, engine] of [
      ['chromium', chromium],
      ['webkit', webkit],
    ].filter(([name]) => !demand || name === 'chromium')) {
      browser = await engine.launch();
      for (const width of demand ? [390] : [390, 1440]) {
        const chain = await batchChain(Date.now() + 7200000, [], new Wallet(batchOwnerKey).address);
        const client = attachBatchRpc(
          new ccc.ClientPublicTestnet({ url: base, fallbacks: [] }),
          chain.rpc,
        );
        const codePaths = ['protocol', 'guard'].map((k) => {
          const manifest = JSON.parse(
            fs.readFileSync(path.join(__dirname, '../contracts/direct-v5/build-manifest.json')),
          );
          return path.join(
            __dirname,
            '../contracts/direct-v5/target/riscv64imac-unknown-none-elf/release',
            manifest[k].binary,
          );
        });
        const owner = (await ccc.Address.fromString(chain.address, client)).script;
        const code = ccc.Transaction.from({
          inputs: [],
          outputs: codePaths.map(() => ({ capacity: 10000000000000n, lock: owner })),
          outputsData: codePaths.map((p) => ccc.hexFrom(fs.readFileSync(p))),
        });
        chain.commit(code);
        const config = {
          ...V5_DIRECT_CONFIG,
          codeDeps: [0, 1].map((index) => ({
            outPoint: { txHash: code.hash(), index },
            depType: 'code',
          })),
        };
        const dir = path.join(temp, `${name}-${width}`),
          registry = new DirectRegistry(path.join(dir, 'registry'), config),
          journal = new OperatorJournal(path.join(dir, 'operator'));
        const fixture = chain.fixtures()[0],
          args = Buffer.alloc(172);
        args.writeBigUInt64LE(BigInt(fixture.cutoffMs), 68);
        Buffer.from(config.guardHash.slice(2), 'hex').copy(args, 76);
        if (!demand)
          registry.add(
            createRecord(
              {
                id: fixture.fixtureId,
                sport: 'football',
                kickoff: new Date(fixture.cutoffMs).toISOString(),
                home: { name: 'Arsenal' },
                away: { name: 'Chelsea' },
                oracle: {
                  provider: 'api-football',
                  fixtureId: fixture.terms.providerFixtureId,
                  source: 'https://v3.football.api-sports.io',
                },
              },
              { codeHash: config.protocolHash, hashType: 'data2', args: ccc.hexFrom(args) },
              code.hash(),
              config,
            ),
          );
        client.findCellsPagedNoCache = async (search) => ({
          cells: [...chain.live.values()].filter((c) =>
            search.scriptType === 'type'
              ? c.cellOutput.type?.eq(search.script)
              : c.cellOutput.lock.eq(search.script),
          ),
          lastCursor: '0x',
        });
        const earlier = new DirectRegistry(path.join(dir, 'earlier'), V4_DIRECT_CONFIG);
        if (rollover) {
          earlier.add(
            createRecord(
              {
                id: fixture.fixtureId,
                sport: 'football',
                kickoff: new Date(fixture.cutoffMs).toISOString(),
                home: { name: 'Arsenal' },
                away: { name: 'Chelsea' },
                oracle: {
                  provider: 'api-football',
                  fixtureId: fixture.terms.providerFixtureId,
                  source: 'https://v3.football.api-sports.io',
                },
              },
              {
                codeHash: V4_DIRECT_CONFIG.protocolHash,
                hashType: 'data2',
                args: ccc.hexFrom(args),
              },
              code.hash(),
              V4_DIRECT_CONFIG,
            ),
          );
        }
        const marketPreparation = demand
          ? new OrderMarkets({
              client,
              journal,
              registry,
              config,
              earlier: rollover ? [earlier] : [],
              signer: new ccc.SignerCkbPrivateKey(client, '0x' + '22'.repeat(32)),
              fixtures: async (ids) =>
                ids.map((id) => ({
                  id,
                  sport: 'football',
                  date: new Date(fixture.cutoffMs).toISOString().slice(0, 10),
                  kickoff: new Date(fixture.cutoffMs).toISOString(),
                  status: 'scheduled',
                  stage: 'Synthetic',
                  home: { id: '1', name: 'Arsenal', code: 'ARS', flag: '' },
                  away: { id: '2', name: 'Chelsea', code: 'CHE', flag: '' },
                  oracle: {
                    provider: 'api-football',
                    fixtureId: id.slice(13),
                    source: 'https://v3.football.api-sports.io',
                  },
                })),
            })
          : undefined;
        if (rollover) {
          assert(marketPreparation.legacyFixtureIds().includes(fixture.fixtureId));
          commitMarketRollovers(registry.directory, [fixture.fixtureId]);
          assert(!marketPreparation.legacyFixtureIds().includes(fixture.fixtureId));
        }
        let clock = Date.now();
        // Every clock read advances, exposing a split createdAt/expiresAt sample.
        const advancingNow = () => (clock = Math.max(Date.now(), clock + 1));
        let service = new OrderService({
            client,
            journal,
            registry,
            config,
            validateFixture: async () => {},
            marketPreparation,
            now: advancingNow,
          }),
          signatures = 0,
          paymentPreparations = 0,
          paymentOffers = 0,
          loseResponse = false,
          walletProjection = null;
        const context = await browser.newContext({
            viewport: { width, height: 900 },
            reducedMotion: 'reduce',
            serviceWorkers: 'block',
          }),
          errors = [],
          external = [];
        await context.addInitScript(
          (value) => {
            window.fixture = value;
          },
          {
            config: service.configuration(),
            address: chain.address,
            fixtureId: fixture.fixtureId,
            fixtureIds: rollover
              ? chain
                  .fixtures()
                  .slice(0, 2)
                  .map((f) => f.fixtureId)
              : [fixture.fixtureId],
          },
        );
        await context.exposeBinding('checkoutRpc', (_s, method, params) =>
          chain.rpc(method, params),
        );
        await context.exposeBinding('checkoutSigning', () => {
          signatures++;
        });
        await context.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== base) {
            external.push(url.href);
            return route.abort();
          }
          if (!url.pathname.startsWith('/api/')) return route.continue();
          const body = route.request().postDataJSON() ?? {};
          let value;
          try {
            switch (url.pathname) {
              case '/api/direct/config':
                value = { orderDeployment: true };
                break;
              case '/api/direct/orders/configuration':
                value = service.configuration();
                break;
              case '/api/direct/orders/prepare-markets':
                paymentPreparations++;
                value = {
                  markets: await marketPreparation.prepare(body.fixtureIds, chain.address),
                };
                break;
              case '/api/direct/orders/wallet':
                value = walletProjection ?? (await service.wallet(chain.address));
                break;
              case '/api/direct/orders/offer':
                paymentOffers++;
                value = await service.prepare(body);
                assert.equal(value.expiresAt - value.createdAt, 120_000);
                break;
              case '/api/direct/orders/submit':
                value = await service.submit(body.offerId, chain.address, body.userSignedBytes);
                if (loseResponse) {
                  loseResponse = false;
                  return route.abort();
                }
                break;
              case '/api/direct/orders/cancel-review':
                value = await service.cancel(body.offerId, chain.address);
                break;
              default:
                throw Error(`Unexpected API ${url.pathname}`);
            }
            return route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify(value),
            });
          } catch (error) {
            return route.fulfill({
              status: 409,
              contentType: 'application/json',
              body: JSON.stringify({ error: error.message }),
            });
          }
        });
        let page = await context.newPage();
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(base);
        const connect = async () => {
          await page.getByRole('button', { name: 'Reconnect wallet', exact: true }).click();
          await page.locator('ccc-connector').waitFor();
          await page.evaluate(() => window.connectTest(document.querySelector('ccc-connector')));
          await page.locator('ccc-connector').waitFor({ state: 'detached' });
        };
        for (let i = 0; i < 3; i++) {
          await page.getByRole('button', { name: 'Add next pick', exact: true }).click();
          if (i === 0) {
            await connect();
            const picksBeforeWarning = await page.evaluate(() => window.checkoutDraft());
            await page.evaluate(() => window.setTestSignType('JoyId'));
            await page
              .getByText('Choose a wallet for predictions', { exact: true })
              .filter({ visible: true })
              .waitFor();
            assert.equal(
              await page.getByRole('button', { name: 'Review payment', exact: true }).count(),
              0,
            );
            assert.equal(
              await page
                .getByRole('link', { name: 'My Account', exact: true })
                .getAttribute('href'),
              '/season/?view=account',
            );
            assert.equal(
              paymentPreparations,
              0,
              'JoyID capability warning must not prepare markets',
            );
            assert.equal(
              paymentOffers,
              0,
              'JoyID capability warning must not request a payment offer',
            );
            assert.deepEqual(
              await page.evaluate(() => window.checkoutDraft()),
              picksBeforeWarning,
              'Unsupported wallet notice preserves all saved picks',
            );
            assert.equal(signatures, 0, 'JoyID capability warning must not request a signature');
            assert.equal((await service.wallet(chain.address)).orders.length, 0);
            await page.screenshot({
              path: path.join(evidence, `${name}-${width}-unsupported-wallet.png`),
              fullPage: true,
            });
            await page.evaluate(() => window.setTestSignType('EvmPersonal'));
          }
          await page.getByRole('button', { name: 'Review payment', exact: true }).click();
          await page.getByRole('heading', { name: 'Approve once. We handle the rest.' }).waitFor();
          if (i === 1) loseResponse = true;
          await page.getByRole('button', { name: /^Approve [0-9]/ }).click();
          await page.waitForFunction(
            (n) => document.querySelectorAll('.order-history article').length === n,
            i + 1,
          );
          await page
            .getByText('Your signed payments are saved. Add more matches to start another slip.')
            .waitFor();
          if (i === 0) {
            const wallet = await service.wallet(chain.address),
              market = marketPreparation?.get(fixture.fixtureId) ?? registry.all()[0];
            const free = [...chain.live.values()].filter(
              (c) =>
                c.cellOutput.lock.eq(owner) &&
                !c.cellOutput.type &&
                c.outputData === '0x' &&
                !wallet.reserved.includes(c.outPoint.toHex()),
            );
            const request = (cell) => ({
              requestId: require('node:crypto').randomUUID(),
              ownerAddress: chain.address,
              userInputs: [{ txHash: cell.outPoint.txHash, index: Number(cell.outPoint.index) }],
              picks: [
                {
                  fixtureId: market.fixtureId,
                  termsHash: market.termsHash,
                  outcome: 0,
                  principalShannons: '10000000000',
                },
              ],
            });
            const reviews = [];
            for (const cell of free.slice(0, 2)) reviews.push(await service.prepare(request(cell)));
            assert.equal(reviews.length, 2);
            await assert.rejects(
              () => service.prepare(request(free[0])),
              /Finish or cancel an open review/,
              'Unsigned reviews and accepted payments must share the three-payment budget',
            );
            for (const review of reviews) await service.cancel(review.id, chain.address);
          }
        }
        assert.equal(signatures, 3);
        if (rollover) {
          const rows = (await service.wallet(chain.address)).orders;
          assert(rows.every((row) => row.offer.markets.length === 2));
          assert(
            rows.every((row) =>
              row.offer.markets.every((market) => market.type.codeHash === config.protocolHash),
            ),
          );
          assert.equal(
            earlier.all().length,
            1,
            'Earlier market record remains available for settlement.',
          );
          assert.equal(
            await page.getByText('Keep these payment versions in separate slips').count(),
            0,
          );
        }
        assert.equal((await service.wallet(chain.address)).orders.length, 3);
        assert.equal(
          chain.transactions.size,
          2,
          'No queue funding was broadcast by this browser test',
        );
        await page.getByRole('button', { name: 'Add next pick', exact: true }).click();
        assert(
          await page
            .getByRole('button', { name: 'Three payments processing', exact: true })
            .isDisabled(),
        );
        await page.screenshot({
          path: path.join(
            evidence,
            `${name}-${width}-${rollover ? 'rollover-' : ''}three-accepted.png`,
          ),
          fullPage: true,
        });
        await page.close();
        service = new OrderService({
          client,
          journal,
          registry,
          config,
          validateFixture: async () => {},
          now: advancingNow,
        });
        page = await context.newPage();
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(base);
        await page.waitForFunction(
          () => document.querySelectorAll('.order-history article').length === 3,
        );
        assert.equal(signatures, 3, 'Restoring accepted history must not sign');
        // Synthetic read projection only. No placement or confirmation is claimed
        // for the transactions in this signing/acceptance fixture.
        walletProjection = structuredClone(await service.wallet(chain.address));
        for (const order of walletProjection.orders) {
          order.state = 'placed';
          order.offer.createdAt -= 3 * 24 * 60 * 60 * 1000;
          order.offer.expiresAt -= 3 * 24 * 60 * 60 * 1000;
        }
        await page.reload();
        const confirmation = page.getByRole('status').filter({ hasText: 'Payment confirmed.' });
        await confirmation.waitFor();
        await page.getByRole('button', { name: 'Dismiss payment confirmation' }).click();
        await confirmation.waitFor({ state: 'hidden' });
        await page.evaluate(() => window.remountCheckout());
        await page.waitForFunction(
          () => document.querySelectorAll('.order-history article').length === 3,
        );
        assert.equal(
          await confirmation.count(),
          0,
          'Dismissed success stays hidden after route remount',
        );
        await page.reload();
        await page.waitForFunction(
          () => document.querySelectorAll('.order-history article').length === 3,
        );
        assert.equal(
          await confirmation.count(),
          0,
          'Days-old dismissed success stays hidden on return',
        );
        await connect();
        assert.equal(await confirmation.count(), 0, 'Wallet restoration does not reset dismissal');
        walletProjection.orders[0].state = 'attention';
        await page.reload();
        await page.waitForFunction(() => typeof window.setSlipActive === 'function');
        await page.evaluate(() => window.setSlipActive(false));
        const pendingTracker = page.locator('.payment-progress[data-stage="queued"]:not([hidden])');
        await pendingTracker.waitFor();
        assert.equal(
          await pendingTracker.getByRole('button', { name: 'Dismiss update' }).count(),
          0,
        );
        walletProjection.orders[0].state = 'placed';
        walletProjection.orders[0].offer.id = require('node:crypto').randomUUID();
        await page.reload();
        await confirmation.waitFor();
        assert.equal(signatures, 3, 'Notification dismissal and restoration never sign');
        walletProjection = null;
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        console.log(
          `${name} ${width}: three signatures, lost acceptance response, new picks, limit, browser close and operator reload passed`,
        );
        await context.close();
        if (!demand && name === 'chromium' && width === 390) {
          await require('./order-scheduling-fixture.cjs')(service);
          await require('./order-recovery-fixture.cjs')(service, owner);
        }
      }
      await browser.close();
      browser = null;
    }
  } finally {
    if (browser) await browser.close();
    await new Promise((r) => server.close(r));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
