import test from 'node:test';
import assert from 'node:assert/strict';
import { OsEventTypeList, validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk';
import type { EvenHubEvent, RebuildPageContainer, CreateStartUpPageContainer } from '@evenrealities/even_hub_sdk';
import { GuideController, rootPage, detailPage } from '../src/guide.ts';
import type { GuideBridge, GuideStatus } from '../src/guide.ts';
import { topics } from '../src/content.ts';

function mockBridge() {
  const pages: Array<CreateStartUpPageContainer | RebuildPageContainer> = [];
  const exits: number[] = [];
  const statuses: GuideStatus[] = [];
  let listener: ((event: EvenHubEvent) => void) | undefined;
  let failNext = false;
  let inFlight = 0;
  let maxInFlight = 0;
  let unsubscribeCount = 0;
  const bridge: GuideBridge = {
    async createStartUpPageContainer(page) { pages.push(page); return 0; },
    async rebuildPageContainer(page) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 2));
      inFlight -= 1;
      if (failNext) { failNext = false; return false; }
      pages.push(page);
      return true;
    },
    async shutDownPageContainer(mode) { exits.push(mode ?? -1); return true; },
    onEvenHubEvent(callback) { listener = callback; return () => { unsubscribeCount++; listener = undefined; }; },
  };
  const guide = new GuideController(bridge, state => statuses.push(state));
  return { bridge, guide, pages, exits, statuses, fail: () => { failNext = true; },
    emit: (event: EvenHubEvent) => listener?.(event),
    maxInFlight: () => maxInFlight, unsubscribeCount: () => unsubscribeCount };
}

const select = (index: number, eventType: OsEventTypeList | undefined = OsEventTypeList.CLICK_EVENT): EvenHubEvent => ({
  listEvent: { containerID: 2, currentSelectItemIndex: index, eventType } as EvenHubEvent['listEvent'],
});
const back: EvenHubEvent = { textEvent: { containerID: 4, eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } as EvenHubEvent['textEvent'] };
const system = (eventType: OsEventTypeList): EvenHubEvent => ({ sysEvent: { eventType } as EvenHubEvent['sysEvent'] });

test('every native page passes the real SDK validator with exactly one input target', () => {
  for (const page of [rootPage(), ...topics.map((_, i) => detailPage(i))]) {
    assert.equal(validateEvenHubPageContainer(page).valid, true);
    const containers = [...page.textObject, ...('listObject' in page ? page.listObject : [])];
    assert.equal(containers.filter(c => c.isEventCapture === 1).length, 1);
    assert.ok(containers.every(c => (c.yPosition ?? 0) + (c.height ?? 0) <= 288));
  }
});

test('startup creates one native root page and can only run once', async () => {
  const m = mockBridge();
  await m.guide.start(); await m.guide.start();
  assert.equal(m.pages.length, 1);
  assert.equal(m.guide.page, null);
  assert.deepEqual(m.statuses, ['ready']);
});

test('item zero with SDK-normalized click opens the first topic', async () => {
  const m = mockBridge(); await m.guide.start();
  const event = select(0); delete event.listEvent!.eventType;
  await m.guide.handle(event);
  assert.equal(m.guide.page, 0);
  assert.equal(m.pages.at(-1)?.textObject?.[0].content, 'Set up');
});

test('invalid, missing, scroll, and unrelated inputs cannot open a page', async () => {
  const m = mockBridge(); await m.guide.start();
  for (const index of [-1, 4, 0.5, NaN, Infinity]) await m.guide.handle(select(index));
  await m.guide.handle({ listEvent: { containerID: 2 } as EvenHubEvent['listEvent'] });
  await m.guide.handle(select(1, OsEventTypeList.SCROLL_BOTTOM_EVENT));
  await m.guide.handle({});
  await m.guide.handle({ listEvent: { ...select(0).listEvent, containerID: 99 } as EvenHubEvent['listEvent'] });
  assert.equal(m.pages.length, 1);
});

test('double-tap goes back from detail and asks system confirmation only on root', async () => {
  const m = mockBridge(); await m.guide.start();
  await m.guide.handle(select(3)); await m.guide.handle(back);
  assert.equal(m.guide.page, null);
  assert.deepEqual(m.exits, []);
  await m.guide.handle({ listEvent: { containerID: 2, eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } as EvenHubEvent['listEvent'] });
  assert.deepEqual(m.exits, [1]);
  await m.guide.handle(select(1)); // User may dismiss the exit confirmation.
  assert.equal(m.guide.page, 1);
});

test('system double-tap uses the same safe back/exit behavior', async () => {
  const m = mockBridge(); await m.guide.start();
  await m.guide.handle(select(1));
  await m.guide.handle(system(OsEventTypeList.DOUBLE_CLICK_EVENT));
  assert.equal(m.guide.page, null);
  await m.guide.handle(system(OsEventTypeList.DOUBLE_CLICK_EVENT));
  assert.deepEqual(m.exits, [1]);
});

test('failed page updates preserve the rendered page and later navigation recovers', async () => {
  const m = mockBridge(); await m.guide.start(); m.fail();
  await m.guide.handle(select(2));
  assert.equal(m.guide.page, null);
  assert.equal(m.statuses.at(-1), 'error');
  await m.guide.handle(select(2));
  assert.equal(m.guide.page, 2);
  m.fail(); await m.guide.handle(back);
  assert.equal(m.guide.page, 2);
  await m.guide.handle(back);
  assert.equal(m.guide.page, null);
});

test('rapid native events are serialized and stale list events do not navigate a detail page', async () => {
  const m = mockBridge(); await m.guide.start();
  await Promise.all([m.guide.handle(select(0)), m.guide.handle(select(3)), m.guide.handle(back), m.guide.handle(select(2))]);
  assert.equal(m.maxInFlight(), 1);
  assert.equal(m.guide.page, 2);
  assert.equal(m.pages.length, 4);
});

test('foreground lifecycle pauses interaction and system exit unsubscribes', async () => {
  const m = mockBridge(); await m.guide.start();
  await m.guide.handle(system(OsEventTypeList.FOREGROUND_EXIT_EVENT));
  await m.guide.handle(select(0)); assert.equal(m.guide.page, null);
  await m.guide.handle(system(OsEventTypeList.FOREGROUND_ENTER_EVENT));
  await m.guide.handle(select(0)); assert.equal(m.guide.page, 0);
  await m.guide.handle(system(OsEventTypeList.SYSTEM_EXIT_EVENT));
  await m.guide.handle(back); assert.equal(m.guide.page, 0);
  assert.equal(m.unsubscribeCount(), 1);
  assert.equal(m.statuses.at(-1), 'closed');
});

test('failed startup reports unavailable and does not subscribe to native input', async () => {
  const m = mockBridge();
  m.bridge.createStartUpPageContainer = async () => 1;
  await m.guide.start();
  assert.deepEqual(m.statuses, ['error']);
  await m.guide.handle(select(0));
  assert.equal(m.pages.length, 0);
});
