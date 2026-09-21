import {
  CreateStartUpPageContainer, ListContainerProperty, ListItemContainerProperty,
  OsEventTypeList, RebuildPageContainer, TextContainerProperty,
} from '@evenrealities/even_hub_sdk';
import type { EvenAppBridge, EvenHubEvent } from '@evenrealities/even_hub_sdk';
import { topics } from './content.ts';

export type GuideBridge = Pick<EvenAppBridge,
  'createStartUpPageContainer' | 'rebuildPageContainer' | 'onEvenHubEvent' | 'shutDownPageContainer'>;
export type GuideStatus = 'ready' | 'background' | 'closed' | 'error';

const MENU_ID = 2;
const DETAIL_ID = 4;

function text(id: number, name: string, y: number, height: number, content: string, capture = 0) {
  return new TextContainerProperty({
    containerID: id, containerName: name, xPosition: 12, yPosition: y,
    width: 552, height, borderWidth: 0, paddingLength: 0,
    content, isEventCapture: capture,
  });
}

export function rootPage() {
  return {
    containerTotalNum: 3,
    textObject: [
      text(1, 'title', 6, 38, 'G2 Bridge Guide'),
      text(3, 'hint', 250, 32, 'Tap to open · Double-tap to exit'),
    ],
    listObject: [new ListContainerProperty({
      containerID: MENU_ID, containerName: 'topics', xPosition: 12, yPosition: 48,
      width: 552, height: 192, paddingLength: 6, borderWidth: 1,
      borderColor: 8, borderRadius: 6, isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: topics.length, itemWidth: 528, isItemSelectBorderEn: 1,
        itemName: topics.map(topic => topic.title),
      }),
    })],
  };
}

export function detailPage(index: number) {
  const topic = topics[index];
  if (!topic) throw new Error('Unknown guide topic');
  return {
    containerTotalNum: 3,
    textObject: [
      text(1, 'title', 6, 38, topic.title),
      text(DETAIL_ID, 'detail', 50, 188, topic.text, 1),
      text(3, 'hint', 250, 32, 'Scroll to read · Double-tap to go back'),
    ],
  };
}

/** A single queue owns page transitions; unsuccessful updates keep the previous page. */
export class GuideController {
  private bridge: GuideBridge;
  private report: (status: GuideStatus) => void;
  private current: number | null = null;
  private queue: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | undefined;
  private started = false;
  private stopped = false;
  private background = false;

  constructor(bridge: GuideBridge, report: (status: GuideStatus) => void) {
    this.bridge = bridge;
    this.report = report;
  }

  get page(): number | null { return this.current; }

  async start() {
    if (this.started || this.stopped) return;
    this.started = true;
    try {
      const result = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(rootPage()));
      if (result !== 0) throw new Error('Page unavailable');
      if (this.stopped) return;
      this.unsubscribe = this.bridge.onEvenHubEvent(event => { void this.handle(event); });
      this.report('ready');
    } catch {
      this.report('error');
      this.stop();
    }
  }

  stop() {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  handle(event: EvenHubEvent): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (this.stopped) return;
      const system = event.sysEvent?.eventType;
      if (system === OsEventTypeList.SYSTEM_EXIT_EVENT || system === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
        this.stop();
        this.report('closed');
        return;
      }
      if (system === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
        this.background = true;
        this.report('background');
        return;
      }
      if (system === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
        this.background = false;
        this.report('ready');
        return;
      }
      if (this.background) return;
      const input = this.current === null ? event.listEvent : event.textEvent;
      const expectedID = this.current === null ? MENU_ID : DETAIL_ID;
      // The system may deliver double-tap independently of the capturing container.
      const doubleTap = system === OsEventTypeList.DOUBLE_CLICK_EVENT ||
        (input?.containerID === expectedID && input.eventType === OsEventTypeList.DOUBLE_CLICK_EVENT);
      if (doubleTap) {
        if (this.current === null) {
          if (!await this.bridge.shutDownPageContainer(1)) throw new Error('Exit unavailable');
        } else {
          if (!await this.bridge.rebuildPageContainer(new RebuildPageContainer(rootPage()))) throw new Error('Page unavailable');
          this.current = null;
          this.report('ready');
        }
        return;
      }
      const selection = event.listEvent;
      if (this.current !== null || selection?.containerID !== MENU_ID ||
          (selection.eventType !== OsEventTypeList.CLICK_EVENT && selection.eventType !== undefined)) return;
      // Accept item zero; absent/invalid selections must never choose a topic implicitly.
      const index = selection.currentSelectItemIndex;
      if (index === undefined || !Number.isInteger(index) || index < 0 || index >= topics.length) return;
      if (!await this.bridge.rebuildPageContainer(new RebuildPageContainer(detailPage(index)))) throw new Error('Page unavailable');
      this.current = index;
      this.report('ready');
    }).catch(() => { this.report('error'); });
    return this.queue;
  }
}
