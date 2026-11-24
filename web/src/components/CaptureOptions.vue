<script setup vapor lang="ts">
import { computed, ref } from 'vue'
import {
  DEFAULT_COUNT,
  optionsSummary,
  ranges,
  scopeOf,
  scopes,
  withScope,
  type Options,
  type Scope,
} from '../capture-options'
import ChevronIcon from './ui/ChevronIcon.vue'
/**
 * The options of a capture or an update, the same wherever one starts. Only
 * what applies to the target shows, and a choice's own options only while
 * it is on.
 */
const {
  profiles = true,
  posts = true,
  relations = true,
  relationsHint = '',
  collapsible = false,
  disabled = false,
} = defineProps<{
  /** The target holds profiles: their timeline and lists. */
  profiles?: boolean
  /** The target holds single posts. */
  posts?: boolean
  /** A profile's lists can be fetched (抓关系网). */
  relations?: boolean
  relationsHint?: string
  /** Folded under a summary line, as on the link form. */
  collapsible?: boolean
  disabled?: boolean
}>()
const model = defineModel<Options>({ required: true })
const open = ref(false)
/** The scope and number 抓帖子 turns back on. */
let last: Pick<Options, 'posts' | 'count'> = { posts: 'latest' }

const timeline = computed(() => profiles && model.value.posts !== 'none')
const scope = computed(() => scopeOf(model.value))
const summary = computed(() => optionsSummary(model.value, { profiles, posts }))

function set(patch: Partial<Options>) {
  model.value = { ...model.value, ...patch }
}
function setPosts(on: boolean) {
  if (on) model.value = { ...model.value, ...last }
  else {
    const { count, ...rest } = model.value
    last = { posts: rest.posts, ...(count === undefined ? {} : { count }) }
    model.value = { ...rest, posts: 'none' }
  }
}
function setCount(event: Event) {
  const input = event.target as HTMLInputElement
  const value = Math.round(Number(input.value))
  const count =
    input.value && Number.isFinite(value)
      ? Math.min(Math.max(value, 1), 100_000)
      : DEFAULT_COUNT
  input.value = String(count)
  set({ count })
}
function setSince(value: string) {
  const { since_days: _, ...rest } = model.value
  model.value = value
    ? { ...rest, since_days: Number(value) as Options['since_days'] }
    : rest
}
const checked = (event: Event) => (event.target as HTMLInputElement).checked
const chosen = (event: Event) => (event.target as HTMLSelectElement).value
</script>

<template>
  <component
    :is="collapsible ? 'details' : 'div'"
    class="capture-options"
    @toggle="
      (event: Event) => (open = (event.target as HTMLDetailsElement).open)
    "
  >
    <summary v-if="collapsible">
      <span class="title">采集选项</span>
      <span class="summary">{{ summary }}</span>
      <ChevronIcon :open="open" />
    </summary>
    <fieldset :disabled="disabled">
      <template v-if="profiles">
        <label class="row"
          ><span>抓帖子</span
          ><input
            class="switch"
            type="checkbox"
            role="switch"
            :checked="model.posts !== 'none'"
            @change="setPosts(checked($event))"
        /></label>
        <template v-if="timeline">
          <label class="row sub"
            ><span>帖子范围</span
            ><span class="select"
              ><select
                class="value"
                aria-label="帖子范围"
                :value="scope"
                @change="model = withScope(model, chosen($event) as Scope)"
              >
                <option v-for="s in scopes" :key="s.value" :value="s.value">
                  {{ s.label }}
                </option></select
              ><ChevronIcon class="select-chevron" /></span
          ></label>
          <label v-if="scope === 'latest' || scope === 'max'" class="row sub"
            ><span>条数</span
            ><input
              class="value"
              type="number"
              inputmode="numeric"
              min="1"
              max="100000"
              step="1"
              aria-label="条数"
              :value="model.count ?? DEFAULT_COUNT"
              @change="setCount"
          /></label>
          <label class="row sub"
            ><span>发帖日期</span
            ><span class="select"
              ><select
                class="value"
                aria-label="发帖日期"
                :value="String(model.since_days ?? '')"
                @change="setSince(chosen($event))"
              >
                <option value="">全部</option>
                <option
                  v-for="r in ranges"
                  :key="r.value"
                  :value="String(r.value)"
                >
                  {{ r.label }}
                </option></select
              ><ChevronIcon class="select-chevron" /></span
          ></label>
          <label class="row sub"
            ><span>仅采集含图片或视频的帖子</span
            ><input
              class="switch"
              type="checkbox"
              role="switch"
              :checked="model.media_only"
              @change="set({ media_only: checked($event) })"
          /></label>
          <label class="row sub"
            ><span>包含引用转帖和纯转发</span
            ><input
              class="switch"
              type="checkbox"
              role="switch"
              :checked="model.include_shared"
              @change="set({ include_shared: checked($event) })"
          /></label>
        </template>
      </template>
      <label v-if="timeline || posts" class="row"
        ><span>采集引用、转发的原帖</span
        ><input
          class="switch"
          type="checkbox"
          role="switch"
          :checked="model.capture_references"
          @change="set({ capture_references: checked($event) })"
      /></label>
      <label v-if="profiles && relations" class="row"
        ><span
          >抓关系网<small v-if="relationsHint" class="hint">{{
            relationsHint
          }}</small></span
        ><input
          class="switch"
          type="checkbox"
          role="switch"
          :checked="model.relations"
          @change="set({ relations: checked($event) })"
      /></label>
    </fieldset>
  </component>
</template>

<style scoped>
.capture-options {
  box-shadow: inset 0 1px 0 var(--separator);
}
fieldset {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  padding: 0 calc(var(--inset) - 4px) 0 var(--inset);
  cursor: pointer;
  list-style: none;
  -webkit-user-select: none;
  user-select: none;
}
summary::-webkit-details-marker {
  display: none;
}
summary:active {
  background: var(--fill);
}
summary:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: -2px;
}
.title {
  flex: none;
  font-size: 16px;
}
.summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  color: var(--subtle);
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
  margin-left: var(--inset);
  padding: 6px var(--inset) 6px 0;
  font-size: 15px;
  box-shadow: inset 0 1px 0 var(--separator);
}
div.capture-options > fieldset > .row:first-child {
  box-shadow: none;
}
.row.sub {
  margin-left: calc(var(--inset) * 2);
}
.hint {
  display: block;
  font-size: 13px;
  color: var(--subtle);
}
.switch {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  flex: none;
  width: 46px;
  height: 28px;
  margin: 0;
  border-radius: 14px;
  background: var(--fill);
  cursor: pointer;
  transition: background 160ms ease;
}
.switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  transition: transform 160ms ease;
}
.switch:checked {
  background: var(--link);
}
.switch:checked::after {
  transform: translateX(18px);
}
.switch:disabled {
  opacity: 0.5;
  cursor: default;
}
.switch:focus-visible,
.value:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}
.value {
  min-height: 32px;
  border: 0;
  border-radius: 8px;
  background: var(--fill);
  font-size: 15px;
  color: inherit;
}
input.value {
  width: 96px;
  padding: 4px 10px;
  text-align: right;
}
.select {
  position: relative;
  flex: none;
}
select.value {
  appearance: none;
  -webkit-appearance: none;
  padding: 4px 30px 4px 10px;
}
.select-chevron {
  position: absolute;
  right: 4px;
  top: calc(50% - 12px);
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .switch,
  .switch::after {
    transition: none;
  }
}
</style>
