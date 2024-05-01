import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from 'rollup-plugin-typescript2';
import del from 'rollup-plugin-delete';

export default [
  {
    input: 'src/index.ts',
    plugins: [
      typescript(),
      resolve({
        preferBuiltins: false
      }),
      commonjs(),
      del({
        targets: [
          'build/transport_*.d.ts',
          'build/json.d.ts',
          'build/utils.d.ts',
        ],
        hook: 'writeBundle',
        runOnce: true,
      }),
    ],
    output: [
      {
        file: 'build/index.js',
        format: 'cjs',
      },
      {
        file: 'build/index.mjs',
        format: 'es',
      }
    ]
  },
];
