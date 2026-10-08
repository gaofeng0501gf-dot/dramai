// 零依赖测试加载器：让 Node 原生 TypeScript（type stripping）认识
//   - Vite 的 '@/…' 路径别名 → src/…
//   - 省略扩展名的 TS 导入（bundler 风格）
// 用法见 package.json 的 "test" 脚本。
import { register } from 'node:module'

register('./resolve-hooks.mjs', import.meta.url)
