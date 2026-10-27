// garnet real-project benchmark: vue core 3.5 (benchmarks/real/run.sh vue) in the production browser
// configuration (garnet-stubs/globals.ts). Two workloads over the workspace's own sources:
//   reactivity: a store of reactive objects, an array, a Map and a Set, refs, computed chains and effects,
//     mutated in a loop (every read and write is a Proxy trap; tracking links subscriber and dependency
//     nodes; a computed re-evaluates lazily from its dirty flag; array iteration goes through the
//     instrumented methods and wraps each element);
//   compiler: a set of templates compiled to render-function source by @vue/compiler-dom (the tokenizer and
//     the parser, the node and directive transforms, codegen; no babel: a browser does not prefix identifiers).
// The checksum adds the effect run counts, the computed sums and a hash of the generated code, so the native
// and the Node runs must agree.
import "./garnet-stubs/globals";
import { reactive, readonly, ref, shallowRef, computed, effect, stop, isReactive, isReadonly, toRaw, triggerRef, markRaw } from "@vue/reactivity";
import { compile } from "@vue/compiler-dom";
import { performance } from "node:perf_hooks";

interface Todo { id: number; title: string; done: boolean; tags: string[] }
interface Store { todos: Todo[]; filter: string; nested: { a: { b: { c: number } } } }

function reactivityRound(n: number): number {
  const state = reactive<Store>({ todos: [], filter: "all", nested: { a: { b: { c: 0 } } } });
  const count = ref(0);
  const doneCount = computed(() => { let k = 0; for (const t of state.todos) if (t.done) k++; return k; });
  const visible = computed(() => state.filter === "all" ? state.todos : state.todos.filter((t) => t.done === (state.filter === "done")));
  const titleLen = computed(() => { let k = 0; for (const t of visible.value) k += t.title.length + t.tags.length; return k; });
  const deep = computed(() => state.nested.a.b.c * 2 + count.value);
  let runs = 0, acc = 0;
  const e1 = effect(() => { runs++; acc = (acc + doneCount.value + titleLen.value) | 0; });
  const e2 = effect(() => { runs++; acc = (acc + deep.value + visible.value.length) | 0; });
  for (let i = 0; i < n; i++) {
    state.todos.push({ id: i, title: "todo " + i, done: (i & 1) === 0, tags: i % 3 === 0 ? ["a", "b"] : ["c"] });
    const t = state.todos[i >> 1];
    if (i % 3 === 0) t.done = !t.done;
    if (i % 7 === 0) state.filter = i % 2 === 0 ? "done" : i % 4 === 1 ? "open" : "all";
    state.nested.a.b.c = i;
    count.value = i;
    if (i % 64 === 63) state.todos.splice(0, 1);
  }
  stop(e1); stop(e2);

  const m = reactive(new Map<string, number>());
  const s = reactive(new Set<number>());
  const msum = computed(() => { let t = 0; m.forEach((v) => { t += v; }); for (const x of s) t += x; return t + m.size * 3; });
  const e3 = effect(() => { runs++; acc = (acc + msum.value) | 0; });
  for (let i = 0; i < n; i++) {
    m.set("k" + (i % 100), i);
    s.add(i % 37);
    if (i % 10 === 0) { m.delete("k" + (i % 50)); s.delete(i % 7); }
    if (m.has("k" + (i % 3))) acc = (acc + 1) | 0;
    if (m.get("k" + (i % 5)) === i) acc = (acc + 2) | 0;
  }
  stop(e3);

  const sr = shallowRef({ n: 0 });
  const ro = readonly(state);
  let roReads = 0;
  const e4 = effect(() => { runs++; roReads = (roReads + ro.todos.length + sr.value.n + ro.nested.a.b.c) | 0; });
  for (let i = 0; i < n; i++) {
    sr.value = { n: i };
    if (i % 100 === 0) triggerRef(sr);
  }
  stop(e4);
  const raw = markRaw({ x: 1 });
  const flags = (isReactive(state.todos) ? 1 : 0) + (isReadonly(ro) ? 2 : 0) + (toRaw(ro) === toRaw(state) ? 4 : 0) + (isReactive(reactive(raw)) ? 0 : 8);
  detail.push(`r${runs}/a${acc}/o${roReads}/l${state.todos.length}/f${flags}/d${doneCount.value}/t${titleLen.value}/m${msum.value}`);
  return (runs + acc + roReads + state.todos.length * 7 + flags) | 0;
}
const detail: string[] = [];

const templates: string[] = [
  `<div id="app" :class="['todo-app', { dark: theme === 'dark' }]">
    <header class="header"><h1>{{ title }}</h1>
      <input class="new-todo" autofocus placeholder="What needs to be done?" v-model.trim="newTodo" @keyup.enter="addTodo">
    </header>
    <section class="main" v-show="todos.length">
      <input id="toggle-all" class="toggle-all" type="checkbox" :checked="remaining === 0" @change="toggleAll">
      <label for="toggle-all">Mark all as complete</label>
      <ul class="todo-list">
        <li v-for="(todo, index) in filteredTodos" :key="todo.id" :class="{ completed: todo.completed, editing: todo === editedTodo }">
          <div class="view">
            <input class="toggle" type="checkbox" v-model="todo.completed">
            <label @dblclick="editTodo(todo)">{{ index + 1 }}. {{ todo.title }}</label>
            <button class="destroy" @click="removeTodo(todo)"></button>
          </div>
          <input v-if="todo === editedTodo" class="edit" type="text" v-model="todo.title" @blur="doneEdit(todo)" @keyup.enter="doneEdit(todo)" @keyup.escape="cancelEdit(todo)">
        </li>
      </ul>
    </section>
    <footer class="footer" v-show="todos.length">
      <span class="todo-count"><strong>{{ remaining }}</strong> <span>{{ remaining === 1 ? 'item' : 'items' }} left</span></span>
      <ul class="filters">
        <li><a href="#/all" :class="{ selected: visibility === 'all' }">All</a></li>
        <li><a href="#/active" :class="{ selected: visibility === 'active' }">Active</a></li>
        <li><a href="#/completed" :class="{ selected: visibility === 'completed' }">Completed</a></li>
      </ul>
      <button class="clear-completed" @click="removeCompleted" v-show="todos.length > remaining">Clear completed</button>
    </footer>
  </div>`,
  `<DataTable :rows="rows" :columns="columns" striped hoverable @sort="onSort" @select="onSelect">
    <template #header="{ column }">
      <span class="th">{{ column.label }}</span>
      <SortIcon v-if="column.sortable" :dir="sortDir(column)" />
    </template>
    <template #cell="{ row, column }">
      <span v-if="column.key === 'status'" :class="['badge', row.status]">{{ row.status }}</span>
      <a v-else-if="column.key === 'name'" :href="'/users/' + row.id" @click.prevent="open(row)">{{ row.name }}</a>
      <time v-else-if="column.key === 'created'" :datetime="row.created">{{ formatDate(row.created) }}</time>
      <span v-else>{{ format(row[column.key], column.format) }}</span>
    </template>
    <template #footer>
      <tr><td :colspan="columns.length">{{ rows.length }} rows, page {{ page }} of {{ pages }}</td></tr>
    </template>
    <template #empty><p class="empty">No rows match the current filter.</p></template>
  </DataTable>`,
  `<form class="signup" @submit.prevent="submit" novalidate>
    <fieldset :disabled="submitting">
      <legend>Create your account</legend>
      <div class="field" v-for="field in fields" :key="field.name" :class="{ invalid: errors[field.name], required: field.required }">
        <label :for="field.name">{{ field.label }}<span v-if="field.required" class="req">*</span></label>
        <select v-if="field.type === 'select'" :id="field.name" v-model="form[field.name]" @change="validate(field)">
          <option value="" disabled>Choose</option>
          <option v-for="opt in field.options" :key="opt.value" :value="opt.value" :disabled="opt.disabled">{{ opt.label }}</option>
        </select>
        <textarea v-else-if="field.type === 'textarea'" :id="field.name" v-model.lazy="form[field.name]" :rows="field.rows || 3" :maxlength="field.max"></textarea>
        <input v-else-if="field.type === 'checkbox'" :id="field.name" type="checkbox" v-model="form[field.name]" :true-value="field.on" :false-value="field.off">
        <input v-else :id="field.name" :type="field.type" v-model.trim="form[field.name]" :placeholder="field.placeholder" :autocomplete="field.autocomplete" @blur="validate(field)" @input="errors[field.name] = ''">
        <p class="error" v-if="errors[field.name]" role="alert">{{ errors[field.name] }}</p>
        <p class="hint" v-else-if="field.hint">{{ field.hint }}</p>
      </div>
      <div class="actions">
        <button type="submit" class="primary" :disabled="!valid || submitting">{{ submitting ? 'Saving...' : 'Create account' }}</button>
        <button type="button" @click="reset">Reset</button>
      </div>
    </fieldset>
  </form>`,
  `<article class="post">
    <header>
      <h2 class="title">Getting started with the compiler</h2>
      <p class="meta"><span class="author">by the team</span> <span class="sep">|</span> <span class="date">March 2024</span></p>
    </header>
    <section class="body">
      <p>The template compiler turns a template string into a render function. It parses the template into an abstract syntax tree, transforms the tree, and generates code.</p>
      <p>Static parts of the tree are hoisted out of the render function so they are created once. Dynamic parts carry patch flags that tell the runtime what can change.</p>
      <ul class="points">
        <li>Parsing is a single pass over the characters.</li>
        <li>Transforms run in a fixed order over every node.</li>
        <li>Codegen writes the function source with a small context object.</li>
        <li>Errors carry the source location of the offending node.</li>
      </ul>
      <pre class="code">const app = createApp(App)
app.mount('#app')</pre>
      <blockquote>Templates are compiled ahead of time in production builds.</blockquote>
      <p>Below is the dynamic part: {{ summary }}</p>
      <p v-if="showDetails" class="details">{{ details }}</p>
    </section>
    <footer class="tags"><span v-for="tag in tags" :key="tag" class="tag">{{ tag }}</span></footer>
  </article>`,
  `<div class="shell">
    <Teleport to="body"><div v-if="modal" class="overlay" @click.self="modal = null"><component :is="modal" v-bind="modalProps" @close="modal = null" /></div></Teleport>
    <Transition name="fade" mode="out-in" appear>
      <KeepAlive :max="5" :include="cached">
        <component :is="currentView" :key="route.path" v-bind="route.props" v-on="viewListeners" />
      </KeepAlive>
    </Transition>
    <nav class="tabs">
      <button v-for="tab in tabs" :key="tab.id" :[tab.attr]="tab.value" :class="{ active: tab.id === current }" @click="current = tab.id" v-text="tab.label"></button>
    </nav>
    <section v-once class="static-once"><h3>{{ bootTitle }}</h3></section>
    <section v-memo="[items.length, selected]">
      <div v-for="item in items" :key="item.id" :class="{ selected: item.id === selected }" v-html="item.html" @click="selected = item.id"></div>
    </section>
    <pre v-pre>{{ this is not interpolated }}</pre>
    <Suspense><template #default><AsyncPanel :id="panelId" /></template><template #fallback><Spinner size="small" /></template></Suspense>
  </div>`,
  `<ul class="tree">
    <template v-for="group in groups" :key="group.id">
      <li class="group" :class="{ open: group.open }" @click="toggle(group)">
        <span class="name">{{ group.name }}</span>
        <span class="count" v-if="group.items.length">({{ group.items.length }})</span>
      </li>
      <template v-if="group.open">
        <li v-for="(item, i) in group.items" :key="item.id" class="item" :style="{ paddingLeft: (item.depth * 12) + 'px', color: item.color }">
          <input type="checkbox" :checked="item.checked" @change="check(item, $event.target.checked)">
          <span v-if="item.kind === 'file'" class="file">{{ item.name }}</span>
          <span v-else-if="item.kind === 'link'" class="link"><a :href="item.href" target="_blank" rel="noopener">{{ item.name }}</a></span>
          <span v-else-if="item.kind === 'folder'" class="folder" @dblclick="descend(item)">{{ item.name }}/</span>
          <span v-else class="unknown">?{{ item.name }}</span>
          <small v-show="i === group.items.length - 1">last</small>
        </li>
      </template>
      <li v-else class="collapsed">...</li>
    </template>
  </ul>`,
  `<div class="cart">
    <table>
      <thead><tr><th>Item</th><th>Qty</th><th>Price</th><th></th></tr></thead>
      <tbody>
        <tr v-for="line in lines" :key="line.sku" :class="{ oos: !line.inStock }">
          <td><img :src="line.image" :alt="line.name" width="40" height="40"> {{ line.name }}</td>
          <td><input type="number" min="0" :max="line.max" :value="line.qty" @input="setQty(line, $event.target.value)"></td>
          <td>{{ money(line.price * line.qty, currency) }}</td>
          <td><button class="remove" :aria-label="'Remove ' + line.name" @click="remove(line)">x</button></td>
        </tr>
      </tbody>
      <tfoot>
        <tr><td colspan="2">Subtotal</td><td>{{ money(subtotal, currency) }}</td><td></td></tr>
        <tr v-if="discount"><td colspan="2">Discount ({{ discount.code }})</td><td>-{{ money(discount.amount, currency) }}</td><td></td></tr>
        <tr><td colspan="2"><strong>Total</strong></td><td><strong>{{ money(total, currency) }}</strong></td><td></td></tr>
      </tfoot>
    </table>
    <p class="note" v-if="lines.some(l => !l.inStock)">Some items are out of stock.</p>
    <button class="checkout" :disabled="!lines.length" @click="checkout">Checkout</button>
  </div>`,
  `<section class="chat" :style="{ '--accent': accent, height: height + 'px' }">
    <div class="messages" ref="list" @scroll.passive="onScroll">
      <div v-for="msg in messages" :key="msg.id" class="msg" :class="[msg.mine ? 'mine' : 'theirs', { pending: msg.pending, failed: msg.error }]">
        <img v-if="!msg.mine" class="avatar" :src="msg.author.avatar" :title="msg.author.name">
        <div class="bubble">
          <p v-for="(para, i) in msg.paragraphs" :key="i">{{ para }}</p>
          <span class="time">{{ relative(msg.sentAt) }}</span>
          <span v-if="msg.edited" class="edited">(edited)</span>
        </div>
        <button v-if="msg.error" class="retry" @click="resend(msg)">Retry</button>
      </div>
    </div>
    <form class="composer" @submit.prevent="send">
      <textarea v-model="draft" rows="1" placeholder="Message" @keydown.enter.exact.prevent="send" @keydown.shift.enter.stop></textarea>
      <button type="submit" :disabled="!draft.trim()">Send</button>
    </form>
  </section>`,
];

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h | 0;
}
const entityMap: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
function decodeEntities(raw: string): string {
  return raw.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => entityMap[m]);
}
function compilerRound(first: boolean): number {
  let total = 0;
  for (let i = 0; i < templates.length; i++) {
    const { code, ast } = compile(templates[i], { hoistStatic: true, decodeEntities, whitespace: i % 2 === 0 ? "condense" : "preserve", comments: i % 3 === 0 });
    if (first) detail.push(`c${i}:${code.length}/${hashStr(code)}/${ast.children.length}`);
    total = (total + code.length + hashStr(code) + ast.children.length) | 0;
  }
  return total;
}

function main(): void {
  const t0 = performance.now();
  let sum = 0;
  for (let r = 0; r < 4; r++) sum = (sum + reactivityRound(600)) | 0;
  const t1 = performance.now();
  for (let r = 0; r < 400; r++) sum = (sum + compilerRound(r === 0)) | 0;
  const t2 = performance.now();
  process.stderr.write(`vue: ${(t2 - t0).toFixed(1)} ms (reactivity ${(t1 - t0).toFixed(1)} ms, compiler ${(t2 - t1).toFixed(1)} ms)\n`);
  console.log(`vue: sum ${sum}`);
  console.log(detail.join(" "));
}
main();
