/*!
 * Copyright 2019, OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { NoopLogger } from '@opentelemetry/core';
import { AsyncHooksScopeManager } from '@opentelemetry/scope-async-hooks';
import { SpanKind, Span } from '@opentelemetry/types';
import * as assert from 'assert';
import * as http from 'http';
import { plugin } from '../../src/http';
import { assertSpan } from '../utils/assertSpan';
import { DummyPropagation } from '../utils/DummyPropagation';
import { httpRequest } from '../utils/httpRequest';
import * as url from 'url';
import { Utils } from '../utils/Utils';
import { NodeTracer } from '@opentelemetry/node-tracer';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/basic-tracer';

const serverPort = 12345;
const hostname = 'localhost';
const memoryExporter = new InMemorySpanExporter();

export const customAttributeFunction = (span: Span): void => {
  span.setAttribute('span kind', SpanKind.CLIENT);
};

describe('HttpPlugin Integration tests', () => {
  describe('enable()', () => {
    before(function(done) {
      // mandatory
      if (process.env.CI) {
        done();
        return;
      }

      Utils.checkInternet(isConnected => {
        if (!isConnected) {
          this.skip();
          // don't disturbe people
        }
        done();
      });
    });

    const scopeManager = new AsyncHooksScopeManager();
    const httpTextFormat = new DummyPropagation();
    const logger = new NoopLogger();
    const tracer = new NodeTracer({
      scopeManager,
      logger,
      httpTextFormat,
    });
    tracer.addSpanProcessor(new SimpleSpanProcessor(memoryExporter));
    beforeEach(() => {
      memoryExporter.reset();
    });

    before(() => {
      try {
        plugin.disable();
      } catch (e) {}
      plugin.enable(http, tracer, tracer.logger);
      const ignoreConfig = [
        `http://${hostname}:${serverPort}/ignored/string`,
        /\/ignored\/regexp$/i,
        (url: string) => url.endsWith(`/ignored/function`),
      ];
      plugin.options = {
        ignoreIncomingPaths: ignoreConfig,
        ignoreOutgoingUrls: ignoreConfig,
        applyCustomAttributesOnSpan: customAttributeFunction,
      };
    });

    after(() => {
      plugin.disable();
    });

    it('should create a rootSpan for GET requests and add propagation headers', async () => {
      let spans = memoryExporter.getFinishedSpans();
      assert.strictEqual(spans.length, 0);

      const result = await httpRequest.get(`http://google.fr/?query=test`);

      spans = memoryExporter.getFinishedSpans();
      const span = spans[0];
      const validations = {
        hostname: 'google.fr',
        httpStatusCode: result.statusCode!,
        httpMethod: 'GET',
        pathname: '/',
        path: '/?query=test',
        resHeaders: result.resHeaders,
        reqHeaders: result.reqHeaders,
      };

      assert.strictEqual(spans.length, 1);
      assert.ok(span.name.indexOf('GET /') >= 0);
      assertSpan(span, SpanKind.CLIENT, validations);
    });

    it('custom attributes should show up on client spans', async () => {
      await httpRequest.get(`http://google.fr/`).then(result => {
        const spans = memoryExporter.getFinishedSpans();
        const span = spans[0];
        const validations = {
          hostname: 'google.fr',
          httpStatusCode: result.statusCode!,
          httpMethod: 'GET',
          pathname: '/',
          resHeaders: result.resHeaders,
          reqHeaders: result.reqHeaders,
        };

        assert.strictEqual(spans.length, 1);
        assert.ok(span.name.indexOf('GET /') >= 0);
        assert.strictEqual(span.attributes['span kind'], SpanKind.CLIENT);
        assertSpan(span, SpanKind.CLIENT, validations);
      });
    });

    it('should create a span for GET requests and add propagation headers with Expect headers', async () => {
      const spans = memoryExporter.getFinishedSpans();
      assert.strictEqual(spans.length, 0);
      const options = Object.assign(
        { headers: { Expect: '100-continue' } },
        url.parse('http://google.fr/')
      );
      await httpRequest.get(options).then(result => {
        const spans = memoryExporter.getFinishedSpans();
        const span = spans[0];
        const validations = {
          hostname: 'google.fr',
          httpStatusCode: 301,
          httpMethod: 'GET',
          pathname: '/',
          resHeaders: result.resHeaders,
          reqHeaders: result.reqHeaders,
        };

        assert.strictEqual(spans.length, 1);
        assert.ok(span.name.indexOf('GET /') >= 0);

        try {
          assertSpan(span, SpanKind.CLIENT, validations);
        } catch (error) {
          // temporary redirect is also correct
          validations.httpStatusCode = 307;
          assertSpan(span, SpanKind.CLIENT, validations);
        }
      });
    });
    for (const headers of [
      { Expect: '100-continue', 'user-agent': 'http-plugin-test' },
      { 'user-agent': 'http-plugin-test' },
    ]) {
      it(`should create a span for GET requests and add propagation when using the following signature: http.get(url, options, callback) and following headers: ${JSON.stringify(
        headers
      )}`, done => {
        let validations: {
          hostname: string;
          httpStatusCode: number;
          httpMethod: string;
          pathname: string;
          reqHeaders: http.OutgoingHttpHeaders;
          resHeaders: http.IncomingHttpHeaders;
        };
        let data = '';
        const spans = memoryExporter.getFinishedSpans();
        assert.strictEqual(spans.length, 0);
        const options = { headers };
        const req = http.get(
          'http://google.fr/',
          options,
          (resp: http.IncomingMessage) => {
            const res = (resp as unknown) as http.IncomingMessage & {
              req: http.IncomingMessage;
            };

            resp.on('data', chunk => {
              data += chunk;
            });
            resp.on('end', () => {
              validations = {
                hostname: 'google.fr',
                httpStatusCode: 301,
                httpMethod: 'GET',
                pathname: '/',
                resHeaders: resp.headers,
                /* tslint:disable:no-any */
                reqHeaders: (res.req as any).getHeaders
                  ? (res.req as any).getHeaders()
                  : (res.req as any)._headers,
                /* tslint:enable:no-any */
              };
            });
          }
        );

        req.once('close', () => {
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assert.ok(spans[0].name.indexOf('GET /') >= 0);
          assert.ok(data);
          assert.ok(validations.reqHeaders[DummyPropagation.TRACE_CONTEXT_KEY]);
          assert.ok(validations.reqHeaders[DummyPropagation.SPAN_CONTEXT_KEY]);
          done();
        });
      });
    }
  });
});