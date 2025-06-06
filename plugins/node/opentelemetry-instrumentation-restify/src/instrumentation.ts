/*
 * Copyright The OpenTelemetry Authors
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

import type * as types from './internal-types';
import type * as restify from 'restify';

import * as api from '@opentelemetry/api';
import type { Server } from 'restify';
import { LayerType } from './types';
import { AttributeNames } from './enums/AttributeNames';
/** @knipignore */
import { PACKAGE_NAME, PACKAGE_VERSION } from './version';
import * as constants from './constants';
import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
  isWrapped,
  safeExecuteInTheMiddle,
} from '@opentelemetry/instrumentation';
import { ATTR_HTTP_ROUTE } from '@opentelemetry/semantic-conventions';
import { isPromise, isAsyncFunction } from './utils';
import { getRPCMetadata, RPCType } from '@opentelemetry/core';
import type { RestifyInstrumentationConfig } from './types';

const supportedVersions = ['>=4.1.0 <12'];

export class RestifyInstrumentation extends InstrumentationBase<RestifyInstrumentationConfig> {
  constructor(config: RestifyInstrumentationConfig = {}) {
    super(PACKAGE_NAME, PACKAGE_VERSION, config);
  }

  private _moduleVersion?: string;
  private _isDisabled = false;

  init() {
    const module = new InstrumentationNodeModuleDefinition(
      constants.MODULE_NAME,
      supportedVersions,
      (moduleExports, moduleVersion) => {
        this._moduleVersion = moduleVersion;
        return moduleExports;
      }
    );

    module.files.push(
      new InstrumentationNodeModuleFile(
        'restify/lib/server.js',
        supportedVersions,
        moduleExports => {
          this._isDisabled = false;
          const Server: any = moduleExports;
          for (const name of constants.RESTIFY_METHODS) {
            if (isWrapped(Server.prototype[name])) {
              this._unwrap(Server.prototype, name);
            }
            this._wrap(
              Server.prototype,
              name as keyof Server,
              this._methodPatcher.bind(this)
            );
          }
          for (const name of constants.RESTIFY_MW_METHODS) {
            if (isWrapped(Server.prototype[name])) {
              this._unwrap(Server.prototype, name);
            }
            this._wrap(
              Server.prototype,
              name as keyof Server,
              this._middlewarePatcher.bind(this)
            );
          }
          return moduleExports;
        },
        moduleExports => {
          this._isDisabled = true;
          if (moduleExports) {
            const Server: any = moduleExports;
            for (const name of constants.RESTIFY_METHODS) {
              this._unwrap(Server.prototype, name as keyof Server);
            }
            for (const name of constants.RESTIFY_MW_METHODS) {
              this._unwrap(Server.prototype, name as keyof Server);
            }
          }
        }
      )
    );

    return module;
  }

  private _middlewarePatcher(original: Function, methodName?: any) {
    const instrumentation = this;
    return function (this: Server, ...handler: types.NestedRequestHandlers) {
      return original.call(
        this,
        instrumentation._handlerPatcher(
          { type: LayerType.MIDDLEWARE, methodName },
          handler
        )
      );
    };
  }

  private _methodPatcher(original: Function, methodName?: any) {
    const instrumentation = this;
    return function (
      this: Server,
      path: any,
      ...handler: types.NestedRequestHandlers
    ) {
      return original.call(
        this,
        path,
        ...instrumentation._handlerPatcher(
          { type: LayerType.REQUEST_HANDLER, path, methodName },
          handler
        )
      );
    };
  }

  // will return the same type as `handler`, but all functions recursively patched
  private _handlerPatcher(
    metadata: types.Metadata,
    handler: restify.RequestHandler | types.NestedRequestHandlers
  ): any {
    if (Array.isArray(handler)) {
      return handler.map(handler => this._handlerPatcher(metadata, handler));
    }
    if (typeof handler === 'function') {
      return (
        req: types.Request,
        res: restify.Response,
        next: restify.Next
      ) => {
        if (this._isDisabled) {
          return handler(req, res, next);
        }
        const route =
          typeof req.getRoute === 'function'
            ? req.getRoute()?.path
            : req.route?.path;

        // replace HTTP instrumentations name with one that contains a route
        const httpMetadata = getRPCMetadata(api.context.active());
        if (httpMetadata?.type === RPCType.HTTP) {
          httpMetadata.route = route;
        }

        const fnName = handler.name || undefined;
        const spanName =
          metadata.type === LayerType.REQUEST_HANDLER
            ? `request handler - ${route}`
            : `middleware - ${fnName || 'anonymous'}`;
        const attributes = {
          [AttributeNames.NAME]: fnName,
          [AttributeNames.VERSION]: this._moduleVersion || 'n/a',
          [AttributeNames.TYPE]: metadata.type,
          [AttributeNames.METHOD]: metadata.methodName,
          [ATTR_HTTP_ROUTE]: route,
        };
        const span = this.tracer.startSpan(
          spanName,
          {
            attributes,
          },
          api.context.active()
        );

        const instrumentation = this;
        const { requestHook } = instrumentation.getConfig();
        if (requestHook) {
          safeExecuteInTheMiddle(
            () => {
              return requestHook(span, {
                request: req,
                layerType: metadata.type,
              });
            },
            e => {
              if (e) {
                instrumentation._diag.error('request hook failed', e);
              }
            },
            true
          );
        }

        const patchedNext = (err?: any) => {
          span.end();
          next(err);
        };
        patchedNext.ifError = next.ifError;

        const wrapPromise = (promise: Promise<unknown>) => {
          return promise
            .then(value => {
              span.end();
              return value;
            })
            .catch(err => {
              span.recordException(err);
              span.end();
              throw err;
            });
        };

        const newContext = api.trace.setSpan(api.context.active(), span);
        return api.context.with(
          newContext,
          (req: types.Request, res: restify.Response, next: restify.Next) => {
            if (isAsyncFunction(handler)) {
              return wrapPromise(handler(req, res, next));
            }
            try {
              const result = handler(req, res, next);
              if (isPromise(result)) {
                return wrapPromise(result);
              }
              span.end();
              return result;
            } catch (err: any) {
              span.recordException(err);
              span.end();
              throw err;
            }
          },
          this,
          req,
          res,
          patchedNext
        );
      };
    }

    return handler;
  }
}
