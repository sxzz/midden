import type { Rule } from 'eslint'

/**
 * ESLint rule `midden/no-click-navigation`: in a Vue component, an event
 * handler must not navigate with `router.push` or by setting `location`.
 * A destination known when the page renders belongs in a link (AppLink,
 * RouterLink, a primitive's `to` prop), so Cmd/Ctrl-click, the middle
 * button and the context menu open it in a new tab like any other link.
 *
 * Allowed: navigating in an `async` function (after an action, such as
 * saving a folder and then opening it), `router.replace` (the same page
 * with other state: filters, toggles), and the `submit` and `search`
 * events of a form. The check follows handlers into the component's own
 * functions, one level deep, which is how they are written here.
 */

interface Node {
  type: string
  [key: string]: unknown
}

const ALLOWED_EVENTS = new Set(['submit', 'search'])

const isNamed = (node: unknown, name: string) =>
  !!node &&
  (node as Node).type === 'Identifier' &&
  (node as { name: string }).name === name

/** `router.push(…)`, `location.hash = …`, `window.location.assign(…)`… */
function isNavigation(node: Node): boolean {
  if (node.type === 'CallExpression') {
    const callee = node.callee as Node
    if (callee.type !== 'MemberExpression') return false
    const object = callee.object as Node
    const property = callee.property as Node
    if (isNamed(property, 'push'))
      return isNamed(object, 'router') || isNamed(object, '$router')
    return (
      (isNamed(property, 'assign') || isNamed(property, 'replace')) &&
      isLocation(object)
    )
  }
  if (node.type === 'AssignmentExpression') {
    const left = node.left as Node
    return (
      isLocation(left) ||
      (left.type === 'MemberExpression' && isLocation(left.object as Node))
    )
  }
  return false
}

function isLocation(node: Node): boolean {
  if (isNamed(node, 'location')) return true
  return (
    node.type === 'MemberExpression' &&
    isNamed(node.property, 'location') &&
    (isNamed(node.object, 'window') || isNamed(node.object, 'globalThis'))
  )
}

const FUNCTIONS = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
])

/** Every node below `node`, not entering nested functions unless `deep`. */
function* walk(node: Node, deep: boolean): Generator<Node> {
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || key === 'tokens' || key === 'comments') continue
    for (const child of Array.isArray(value) ? value : [value]) {
      if (!child || typeof child !== 'object' || !('type' in child)) continue
      const next = child as Node
      if (!deep && FUNCTIONS.has(next.type)) continue
      yield next
      yield* walk(next, deep)
    }
  }
}

const nameOf = (node: unknown) => (node as { name: string }).name

/**
 * The component's functions that navigate synchronously, by name: directly,
 * or by calling another such function.
 */
function navigatingFunctions(program: Node): Set<string> {
  const functions = new Map<string, Node[]>()
  const add = (id: unknown, fn: Node | undefined) => {
    if (fn && FUNCTIONS.has(fn.type) && !fn.async)
      functions.set(nameOf(id), [...walk(fn.body as Node, false)])
  }
  for (const statement of program.body as Node[]) {
    if (statement.type === 'FunctionDeclaration') add(statement.id, statement)
    if (statement.type === 'VariableDeclaration')
      for (const declarator of statement.declarations as Node[])
        if ((declarator.id as Node).type === 'Identifier')
          add(declarator.id, declarator.init as Node | undefined)
  }
  const names = new Set<string>()
  let grew = true
  while (grew) {
    grew = false
    for (const [name, body] of functions) {
      if (names.has(name)) continue
      const navigates = body.some(
        (node) =>
          isNavigation(node) ||
          (node.type === 'CallExpression' &&
            (node.callee as Node).type === 'Identifier' &&
            names.has(nameOf(node.callee))),
      )
      if (navigates) {
        names.add(name)
        grew = true
      }
    }
  }
  return names
}

export const noClickNavigation: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow navigating from event handlers; render a link instead.',
    },
    messages: {
      navigation:
        'This handler navigates. Render a link (AppLink, RouterLink or a `to` prop) so a modified or middle click opens a new tab; navigate in an async function only after an action.',
    },
    schema: [],
  },
  create(context) {
    const services = context.sourceCode.parserServices as {
      defineTemplateBodyVisitor?: (
        template: Record<string, (node: Node) => void>,
      ) => Rule.RuleListener
    }
    if (!services.defineTemplateBodyVisitor) return {}
    let navigating: Set<string> | undefined
    return services.defineTemplateBodyVisitor({
      'VAttribute[directive=true][key.name.name="on"]': function (
        attribute: Node,
      ) {
        const key = attribute.key as { argument?: Node | null }
        const event = key.argument as { name?: string } | null | undefined
        if (event?.name && ALLOWED_EVENTS.has(event.name)) return
        const value = attribute.value as { expression?: Node | null } | null
        const expression = value?.expression
        if (!expression) return
        navigating ??= navigatingFunctions(
          context.sourceCode.ast as unknown as Node,
        )
        const names = navigating
        const nodes = [expression, ...walk(expression, true)]
        const found = nodes.some(
          (node) =>
            isNavigation(node) ||
            (node.type === 'Identifier' && names.has(nameOf(node))),
        )
        if (found)
          context.report({
            node: attribute as unknown as Rule.Node,
            messageId: 'navigation',
          })
      },
    })
  },
}
