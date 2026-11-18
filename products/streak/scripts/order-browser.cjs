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
const demand = process.argv.includes('--demand');
const {
  DirectRegistry,
  V5_DIRECT_CONFIG,
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
 import {configureOrderManifest} from ${source('../web/src/features/direct/protocol.ts')};
 import {connect} from ${source('checkout-browser-wallet.mjs')};
 import ${source('../web/src/design-system/styles.css')};
 const fixture=window.fixture;configureOrderManifest(fixture.config);
 const store=new DraftStore(localStorage);window.connectTest=connect;
 const qc=new QueryClient({defaultOptions:{queries:{retry:false}}});
 function App(){const [busy,setBusy]=useState(false),[target,setTarget]=useState(null);
 return <main style={{maxWidth:600,margin:'auto',padding:20}}><h1>Queued predictions</h1>
 <button className="quiet" disabled={busy} onClick={()=>store.select('market-test',fixture.fixtureId,'home')}>Add next pick</button>
 <${demand ? 'PaymentCheckout' : 'OrderCheckout'} store={store} account={{id:'order-browser-user',username:'Test manager',walletAddress:fixture.address}} accountReady={true} onSignIn={()=>{}} signInPending={false} active={true} onBusy={setBusy} activityTarget={target} config={fixture.config}/>
 <section aria-label="Saved payments" ref={setTarget}/></main>}
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
        const marketPreparation = demand
          ? new OrderMarkets({
              client,
              journal,
              registry,
              config,
              earlier: [],
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
        let service = new OrderService({
            client,
            journal,
            registry,
            config,
            validateFixture: async () => {},
            marketPreparation,
          }),
          signatures = 0,
          loseResponse = false;
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
          { config: service.configuration(), address: chain.address, fixtureId: fixture.fixtureId },
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
                value = {
                  markets: await marketPreparation.prepare(body.fixtureIds, chain.address),
                };
                break;
              case '/api/direct/orders/wallet':
                value = await service.wallet(chain.address);
                break;
              case '/api/direct/orders/offer':
                value = await service.prepare(body);
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
          if (i === 0) await connect();
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
          path: path.join(evidence, `${name}-${width}-three-accepted.png`),
          fullPage: true,
        });
        await page.close();
        service = new OrderService({
          client,
          journal,
          registry,
          config,
          validateFixture: async () => {},
        });
        page = await context.newPage();
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(base);
        await page.waitForFunction(
          () => document.querySelectorAll('.order-history article').length === 3,
        );
        assert.equal(signatures, 3, 'Restoring accepted history must not sign');
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
