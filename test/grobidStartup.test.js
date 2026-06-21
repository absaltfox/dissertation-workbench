import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('GROBID startup uses GROBID_FLY_API_TOKEN for companion Fly Machines API calls', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    FLY_APP_NAME: process.env.FLY_APP_NAME,
    GROBID_APP_NAME: process.env.GROBID_APP_NAME,
    GROBID_FLY_API_TOKEN: process.env.GROBID_FLY_API_TOKEN,
    FLY_API_TOKEN: process.env.FLY_API_TOKEN,
  };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grobid-token-test-'));
  const pdfPath = path.join(tempDir, 'sample.pdf');
  const requests = [];

  process.env.FLY_APP_NAME = 'dissertation-workbench';
  process.env.GROBID_APP_NAME = 'dissertation-workbench-grobid';
  process.env.FLY_API_TOKEN = 'general-worker-token';
  process.env.GROBID_FLY_API_TOKEN = 'grobid-companion-token';

  await fs.writeFile(pdfPath, Buffer.from('%PDF-1.4\n%%EOF'));

  globalThis.fetch = async (url, options = {}) => {
    const textUrl = String(url);
    const authorization = options.headers?.Authorization || options.headers?.authorization || '';
    requests.push({ url: textUrl, authorization, method: options.method || 'GET' });

    if (textUrl.includes('/v1/apps/dissertation-workbench-grobid/machines') && !textUrl.endsWith('/start')) {
      return new Response(JSON.stringify([{ id: 'machine-1', state: 'stopped' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (textUrl.endsWith('/machines/machine-1/start')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (textUrl.endsWith('/api/isalive')) {
      return new Response('true', { status: 200 });
    }

    if (textUrl.endsWith('/api/processReferences')) {
      return new Response(`
        <TEI>
          <text>
            <back>
              <listBibl>
                <biblStruct>
                  <analytic>
                    <title level="a">Teaching with story in public schools</title>
                    <author>
                      <persName><forename>Robin</forename><surname>Scholar</surname></persName>
                    </author>
                  </analytic>
                  <monogr><title level="j">Journal of Education</title></monogr>
                  <date when="2020"/>
                  <note type="raw_reference">Scholar, R. (2020). Teaching with story in public schools.</note>
                </biblStruct>
              </listBibl>
            </back>
          </text>
        </TEI>
      `, { status: 200, headers: { 'content-type': 'application/xml' } });
    }

    return new Response('not found', { status: 404 });
  };

  try {
    const { parseBibliographyWithGrobid } = await import(`../src/pdf.js?grobid-token-test=${Date.now()}`);
    const citations = await parseBibliographyWithGrobid(pdfPath);

    assert.equal(citations.length, 1);
    assert.equal(citations[0].title, 'Teaching with story in public schools');

    const flyMachineRequests = requests.filter((request) => request.url.includes('://_api.internal:4280/'));
    assert.equal(flyMachineRequests.length, 2);
    assert.ok(flyMachineRequests.every((request) => request.authorization === 'Bearer grobid-companion-token'));
    assert.ok(flyMachineRequests.every((request) => request.authorization !== 'Bearer general-worker-token'));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
