export const GUIDE_URL = 'https://daviddemri26.github.io/G2_Terminal_Codex_Mac_App/';
export const ISSUES_URL = 'https://github.com/daviddemri26/G2_Terminal_Codex_Mac_App/issues';

export const topics = [
  {
    id: 'setup', title: 'Set up',
    text: 'On your Mac, install:\nEven Terminal for Codex Mac App.\nOpen Connect and show the pairing code.\nScan it in Terminal Mode on your phone.\nFull setup instructions are on your phone.',
  },
  {
    id: 'daily', title: 'Daily use',
    text: 'In Even Terminal, while Codex is working:\nLong-press > Yes > Add prompt.\nLong-press again to dictate.\nSteer adds context now; Queue saves it for later.\nView queue manages waiting prompts.',
  },
  {
    id: 'help', title: 'Troubleshoot',
    text: 'Start with Overview in the companion Mac App.\nCheck the configured network on both devices.\nUncertain send? Check the Codex Mac App first.\nFor a changed LAN address: finish the interaction,\nrestart safely, then scan a new QR. Help is on phone.',
  },
  {
    id: 'about', title: 'About',
    text: 'Even Terminal for Codex Mac App\nSame Mac tasks on G2 and Remote on iPhone.\nKeep the Mac awake, logged in, and connected.\nThis offline guide cannot chat or pair devices.\nIndependent community project. Details on phone.',
  },
] as const;

export type Topic = typeof topics[number];
