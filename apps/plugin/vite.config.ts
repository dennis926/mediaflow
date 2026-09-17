import { crx } from '@crxjs/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import manifest from './src/manifest';
import { resolvePluginBranding } from './src/manifest.config';

/** Popup HTML ships a neutral title; the configured brand name is injected at build time. */
function brandingHtml(): Plugin {
  const branding = resolvePluginBranding();
  return {
    name: 'mediaflow-branding-html',
    transformIndexHtml(html: string) {
      return html
        .replace(/<title>[^<]*<\/title>/, `<title>${branding.name}</title>`)
        .replace('<div id="root"></div>', `<div id="root"></div>\n    <meta name="description" content="${branding.description}" />`);
    },
  };
}

export default defineConfig({
  plugins: [brandingHtml(), react(), crx({ manifest })],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
