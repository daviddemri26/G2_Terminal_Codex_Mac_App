"""launchd child: supervise only the verified HTTP bridge, never the Mac engine."""
import argparse
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import signal
import subprocess
import time

from common import (BridgeError, DEFAULT_SUPPORT, EXPECTED_BUILD, api, child_environment,
                    command_output, desktop_build, exclusive_lock, idle, load_config,
                    pending_delivery, port_available, private_directory, read_json, status, validate_release)


def network_address(config):
    if config.get('network', {}).get('mode') != 'tailscale':
        return 'configured-network'
    try:
        address = command_output(['/usr/local/bin/tailscale', 'ip', '-4'], timeout=4).splitlines()[0]
        return address if address.startswith('100.') else None
    except (OSError, subprocess.SubprocessError, IndexError):
        return None


class Supervisor:
    def __init__(self, support):
        self.support = Path(support)
        self.stop_requested = False
        self.child = None
        self.last_code = None
        self.log = logging.getLogger('even-codex-bridge')
        self.log.setLevel(logging.INFO)
        logs = private_directory(self.support / 'logs')
        handler = RotatingFileHandler(logs / 'operations.log', maxBytes=1024 * 1024, backupCount=4)
        handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
        self.log.addHandler(handler)
        os.chmod(logs / 'operations.log', 0o600)

    def report(self, code, detail, action='', **extra):
        status(self.support, code, detail, action, supervisorPid=os.getpid(),
               bridgePid=self.child.pid if self.child and self.child.poll() is None else None, **extra)
        if code != self.last_code:
            # Only controlled operational text enters logs: no raw child output, tokens, or prompts.
            self.log.info('%s: %s %s', code, detail, action)
            self.last_code = code

    def signal_stop(self, *_):
        self.stop_requested = True

    def pause(self, seconds):
        deadline = time.monotonic() + seconds
        while not self.stop_requested and time.monotonic() < deadline:
            time.sleep(min(.25, max(0, deadline - time.monotonic())))

    def stop_child(self):
        if self.child is not None and self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                # This PID is our HTTP child, never a Mac app or Codex task engine.
                self.child.kill()
                self.child.wait(timeout=3)
        self.child = None

    def spawn(self, root, manifest, config_path):
        self.child = subprocess.Popen([manifest['nodeExecutable'], str(root / 'package/bin/cli.js'),
            '--config', str(config_path), '--log-level', 'info', '--log-file', '/dev/null'],
            cwd=self.support, env=child_environment(self.support), stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        # Deliberately remain in launchd's process group: no orphan child on supervisor failure.

    def run(self):
        for name in ('state', 'run', 'logs'):
            private_directory(self.support / name)
        signal.signal(signal.SIGTERM, self.signal_stop)
        signal.signal(signal.SIGINT, self.signal_stop)
        with exclusive_lock(self.support / 'run/supervisor.lock'):
            try:
                while not self.stop_requested:
                    try:
                        control = read_json(self.support / 'control.json')
                        config = load_config(control['configPath'])
                    except Exception as error:
                        self.report('update_required', 'The verified bridge cannot start.',
                            str(error) if isinstance(error, BridgeError) else
                            'Run the bridge health check and validate the installed runtime before restarting.')
                        self.pause(20)
                        continue
                    address = network_address(config)
                    if address is None:
                        self.report('waiting_for_tailscale', 'Waiting for the existing Tailscale connection.',
                                    'Open Tailscale on this Mac and connect it.')
                        self.pause(5)
                        continue
                    if not port_available(config.get('port', 3456)):
                        self.report('port_in_use', 'Another process is already using the bridge port.',
                            'Use the managed migration or stop the other bridge; no duplicate will be started.')
                        self.pause(10)
                        continue
                    try:
                        root, manifest = validate_release(self.support, control['activeRelease'])
                    except Exception as error:
                        self.report('update_required', 'The verified bridge cannot start.',
                            str(error) if isinstance(error, BridgeError) else
                            'Run the bridge health check and validate the installed runtime before restarting.')
                        self.pause(20)
                        continue
                    self.report('starting', 'Starting the verified desktop bridge.')
                    try:
                        self.spawn(root, manifest, control['configPath'])
                        started_at = time.monotonic()
                        last_healthy = started_at
                        network_changed = False
                        while not self.stop_requested and self.child.poll() is None:
                            available = network_address(config)
                            if available and available != address:
                                network_changed = True
                            if network_changed:
                                try:
                                    may_restart = idle(config) and not pending_delivery(self.support)
                                except Exception:
                                    may_restart = False
                                if may_restart:
                                    self.report('reconnecting', 'The network address changed; reconnecting the idle bridge.')
                                    break
                            try:
                                info = api(config, '/api/info?provider=codex')
                                if info.get('version') != manifest['bridgeVersion']:
                                    self.report('unexpected_service', 'The local service does not match this verified bridge.',
                                                'Inspect the bridge installation before using it.')
                                    break
                                last_healthy = time.monotonic()
                                build = desktop_build()
                                if build is None:
                                    self.report('waiting_for_desktop', 'The Mac app is unavailable.',
                                                'Restore the Mac app. The HTTP bridge remains available.')
                                elif build != manifest['desktopBuild']:
                                    self.report('desktop_update_required', 'The Mac app version needs compatibility verification.',
                                        'Keep the app open and update the bridge. The HTTP connection stays available.')
                                elif not (Path.home() / '.codex/ipc/ipc.sock').exists():
                                    self.report('waiting_for_desktop', 'The bridge is ready; the Mac app is closed or starting.',
                                                'Open the Mac app. Your selected task will reconnect automatically.')
                                elif not available:
                                    self.report('waiting_for_tailscale', 'The bridge is running; Tailscale is unavailable.',
                                                'Reconnect Tailscale. Desktop tasks continue running.')
                                elif network_changed:
                                    self.report('reconnect_pending', 'The network changed while a bridge task is active.',
                                                'The bridge will reconnect after the active interaction finishes.')
                                else:
                                    self.report('ready', 'The desktop bridge is available.')
                            except Exception:
                                self.report('starting' if time.monotonic() - started_at < 20 else 'unreachable',
                                    'Waiting for the local bridge response.',
                                    'If this persists, run the bridge health check. No prompt will be resent.')
                                if time.monotonic() - last_healthy >= 60:
                                    self.report('reconnecting', 'The HTTP bridge stopped responding; reconnecting it.',
                                                'The Mac engine remains running. Unconfirmed messages will not be resent.')
                                    break
                            self.pause(5)
                    except Exception:
                        self.report('restart_pending', 'The HTTP bridge could not start.',
                                    'The supervisor will retry the same verified release; no separate engine will be launched.')
                    finally:
                        self.stop_child()
                    if not self.stop_requested:
                        self.report('restart_pending', 'The HTTP bridge stopped; reconnecting with the same verified release.',
                                    'Desktop tasks continue running. Messages are never automatically resent.')
                        self.pause(5)
            finally:
                self.stop_child()
                self.report('stopped', 'Automatic bridge supervision stopped.', 'Desktop tasks remain in the Mac app.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--support', type=Path, default=DEFAULT_SUPPORT)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        Supervisor(args.support).run()
    except BridgeError:
        # A second supervisor exits without touching the existing one's status or process.
        return 73
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
