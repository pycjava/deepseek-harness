/**
 * 宿主 Context 测试桩：与 dsh Context 形态一致的最小实现。
 * 插件运行期零 @deepseek-ai/* 依赖，无需模块别名——测试直接把本桩
 * `as unknown as Context` 传入。
 */

export class FakeCommands {
  readonly registrations: Array<{
    name: string
    handler: (invocation: { rawInput?: string }) => Promise<{ kind: string; text: string }>
  }> = []
  register(definition: {
    name: string
    handler: (invocation: { rawInput?: string }) => Promise<{ kind: string; text: string }>
  }): () => void {
    this.registrations.push(definition)
    return () => {
      const idx = this.registrations.indexOf(definition)
      if (idx >= 0) this.registrations.splice(idx, 1)
    }
  }
}

export class StubContext {
  readonly logs: Array<{ level: string; message: string }> = []
  readonly effects: Array<() => void> = []

  readonly logger = {
    info: (message: string) => this.logs.push({ level: 'info', message }),
    warn: (message: string) => this.logs.push({ level: 'warn', message }),
    error: (message: string) => this.logs.push({ level: 'error', message }),
    debug: (message: string) => this.logs.push({ level: 'debug', message }),
  }

  readonly commands = new FakeCommands()

  /** cordis 语义：立即调用 setup，其返回值（函数）作为卸载器。 */
  effect(setup: () => (() => void) | undefined, _label?: string): void {
    const result = setup()
    if (typeof result === 'function') this.effects.push(result)
  }
  inject(_deps: string[], cb: (ctx: StubContext) => void): void {
    cb(this)
  }
}
