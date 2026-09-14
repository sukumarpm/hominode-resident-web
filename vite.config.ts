import { existsSync } from 'node:fs';
import type { PreviewServer } from 'vite';
import hostingConfig from './firebase.json';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig(({ mode, command }) => {
  if (mode === 'browser-test' && command === 'build')
    throw Error('The offline browser harness cannot be built for production.');
  return {
    plugins: [
      react(),
      {
        name: 'firebase-hosting-preview',
        configurePreviewServer(server: PreviewServer) {
          server.middlewares.use((req, _res, next) => {
            const pathname = new URL(req.url || '/', 'http://localhost').pathname;
            if (
              req.headers.accept?.includes('text/html') &&
              pathname !== '/' &&
              !existsSync(resolve('dist', '.' + pathname))
            ) {
              for (const rule of hostingConfig.hosting.rewrites) {
                if (
                  ('regex' in rule && rule.regex && new RegExp(rule.regex).test(pathname)) ||
                  ('source' in rule && rule.source === '**')
                ) {
                  req.url = rule.destination;
                  break;
                }
              }
            }
            next();
          });
        },
      },
      ...(mode === 'browser-test'
        ? [
            {
              name: 'offline-browser-harness',
              enforce: 'pre' as const,
              resolveId(source: string, importer?: string) {
                if (importer?.includes('/src/') && ['./data', './firebase'].includes(source))
                  return resolve('e2e/' + source.slice(2) + '.ts');
              },
              configureServer(server: {
                middlewares: {
                  use: (
                    handler: (
                      req: { headers: { accept?: string }; url?: string },
                      res: unknown,
                      next: () => void,
                    ) => void,
                  ) => void;
                };
              }) {
                server.middlewares.use((req, _res, next) => {
                  if (req.headers.accept?.includes('text/html')) req.url = '/e2e/harness.html';
                  next();
                });
              },
            },
          ]
        : []),
    ],
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      exclude: ['e2e/**', 'node_modules/**'],
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            'firebase-core': ['firebase/app'],
            'firebase-auth': ['firebase/auth'],
            'firebase-firestore': ['firebase/firestore'],
            'firebase-services': ['firebase/functions', 'firebase/app-check', 'firebase/storage'],
            react: ['react', 'react-dom/client', 'react-router-dom'],
          },
        },
      },
    },
  };
});
