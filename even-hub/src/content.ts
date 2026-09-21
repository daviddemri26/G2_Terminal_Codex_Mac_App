export const GUIDE_URL = 'https://daviddemri26.github.io/G2_Terminal_Codex_Mac_App/';
export const ISSUES_URL = 'https://github.com/daviddemri26/G2_Terminal_Codex_Mac_App/issues';

export const topics = [
  {
    id: 'setup', title: 'Set up',
    text: 'On your Mac, install:\nEven Terminal for Codex Mac App.\nOpen Connect and show the pairing code.\nScan it in Terminal Mode on your phone.\nFull setup instructions are on your phone.',
  },
  {
    id: 'daily', title: 'Daily use',
    text: 'Open Even Terminal to use conversations.\nKeep the Mac awake, logged in, and Codex open.\nChoose a conversation you recognize.\nRead replies and continue that conversation.\nThe Mac companion shows status and text options.',
  },
  {
    id: 'help', title: 'Troubleshoot',
    text: 'Start with Overview in the Mac companion.\nCheck the configured network on both devices.\nAfter an uncertain send, check Codex before retrying.\nFor a changed LAN address: finish the interaction,\nrestart safely, then scan a new QR. Help is on phone.',
  },
  {
    id: 'about', title: 'About',
    text: 'Even Terminal for Codex Mac App\nUse Even Terminal with your Codex Mac app.\nNo separate Codex CLI workflow is needed.\nThis offline guide cannot chat or pair devices.\nIndependent community project. Details on phone.',
  },
] as const;

export type Topic = typeof topics[number];
