import { describe, expect, it } from 'vitest';
import { createEngineOpponent } from '../../src/ai/opponent.js';
import { buildApp } from '../../src/server/app.js';
import { openApiDocument } from '../../src/server/openapi.js';

const engine = createEngineOpponent(() => 0);
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** Fastify teede loend printRoutes väljundist: [meetod, tee]. */
function fastifyRoutes(tree: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  for (const line of tree.split('\n')) {
    const m = /^([│ ]*)[├└]── (\S+) \(([^)]+)\)$/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    stack.push(m[2]!);
    const path = stack.join('').replace(/:(\w+)/g, '{$1}');
    for (const method of m[3]!.split(', ')) if (method !== 'HEAD') out.push(`${method.toLowerCase()} ${path}`);
  }
  return out.sort();
}

describe('OpenAPI', () => {
  it('kirjeldab iga serveri tee ja ainult neid', async () => {
    const app = buildApp({ opponents: { engine, claude: engine } });
    await app.ready();
    const routes = fastifyRoutes(app.printRoutes({ commonPrefix: false }));
    expect(routes.length).toBeGreaterThan(30);
    const doc = openApiDocument() as { paths: Record<string, Record<string, unknown>> };
    const documented = Object.entries(doc.paths)
      .flatMap(([path, ops]) => METHODS.filter((m) => m in ops).map((m) => `${m} ${path}`))
      .sort();
    expect(documented).toEqual(routes);
    await app.close();
  });

  it('on kättesaadav ilma võtmeta ja viited on olemas', async () => {
    const app = buildApp({ opponents: { engine, claude: engine }, security: { apiToken: 'a'.repeat(32) } });
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe('3.1.0');
    const schemas = Object.keys(doc.components.schemas);
    const refs = [...JSON.stringify(doc).matchAll(/#\/components\/schemas\/(\w+)/g)].map((m) => m[1]);
    for (const r of refs) expect(schemas).toContain(r);
    // Teised teed nõuavad endiselt võtit.
    expect((await app.inject({ method: 'GET', url: '/api/games' })).statusCode).toBe(401);
    await app.close();
  });
});
