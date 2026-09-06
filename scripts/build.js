import esbuild from 'esbuild'
import fs from 'node:fs/promises'
import packJSON from '../package.json' with { type: 'json' }

const result = await esbuild.build({
  entryPoints: ['src/client/hear.js'],
  bundle: true,
  banner: { js: `/* wiki-plugin-hear ${packJSON.version} */` },
  format: 'iife',
  outfile: 'client/hear.js',
  sourcemap: true,
  minify: true,
  metafile: true
})
await fs.writeFile('meta-client.json', JSON.stringify(result.metafile))
console.log('built client/hear.js')
