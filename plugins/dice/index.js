// Minimal Whales plugin. A plugin is a self-contained folder: no dependencies, no build step.
// `export default` a Cordis plugin object; declare every service you use in `inject`.
export default {
  name: 'dice',
  inject: ['tools'],
  apply(ctx, config = {}) {
    const defaultSides = Number.isInteger(config.sides) && config.sides > 1 ? config.sides : 6
    ctx.tools.register({
      spec: {
        name: 'roll_dice',
        description: `Roll one or more dice. Default ${defaultSides} sides.`,
        inputSchema: {
          type: 'object',
          properties: {
            count: { type: 'integer', minimum: 1, maximum: 20 },
            sides: { type: 'integer', minimum: 2, maximum: 1000 },
          },
          additionalProperties: false,
        },
      },
      // null = no side effects, so no approval is needed.
      describe() {
        return null
      },
      async run(input) {
        const count = Math.min(Math.max(Number(input?.count ?? 1) | 0, 1), 20)
        const sides = Math.min(Math.max(Number(input?.sides ?? defaultSides) | 0, 2), 1000)
        const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides))
        return { output: `${rolls.join(', ')} (total ${rolls.reduce((a, b) => a + b, 0)})`, isError: false }
      },
    })
  },
}
