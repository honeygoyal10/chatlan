import { Capacitor, registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { Device } from '@capacitor/device';
import { LocalNotifications } from '@capacitor/local-notifications';
import { App as CapApp } from '@capacitor/app';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

const BackgroundConnection = registerPlugin('BackgroundConnection');

window.LanChatNative = {
  isNative: Capacitor.isNativePlatform(),
  Preferences,
  Device,
  LocalNotifications,
  CapApp,
  BackgroundConnection,
  Filesystem,
  FilesystemDirectory: Directory,
  Share
};
