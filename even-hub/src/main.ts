import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { GuideController } from './guide.ts';
import type { GuideStatus } from './guide.ts';
import './style.css';

const status = document.getElementById('guide-status');
const messages: Record<GuideStatus, string> = {
  ready: 'Glasses guide initialized. Scroll to choose a topic, then tap to read.',
  background: 'Glasses guide is in the background. The phone guide is still available.',
  closed: 'Glasses guide closed. You can keep reading on this screen.',
  error: 'Glasses guide is unavailable here. You can read all instructions on this screen.',
};
let controller: GuideController | undefined;
let disposed = false;
const fallback = window.setTimeout(() => {
  if (status) status.textContent = 'Phone guide ready. Open this companion in Even Hub to read it on your glasses.';
}, 6000);

void waitForEvenAppBridge().then(async bridge => {
  if (disposed) return;
  controller = new GuideController(bridge, state => {
    window.clearTimeout(fallback);
    if (status) status.textContent = messages[state];
  });
  await controller.start();
}).catch(() => {
  window.clearTimeout(fallback);
  if (status) status.textContent = messages.error;
});

window.addEventListener('pagehide', () => {
  disposed = true;
  window.clearTimeout(fallback);
  controller?.stop();
}, { once: true });
