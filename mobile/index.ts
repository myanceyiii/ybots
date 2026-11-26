import { registerRootComponent } from 'expo';
import { AppRegistry, Platform } from 'react-native';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App).
// On the web (only used for screenshots of the screens with demo data) it shows the preview instead.
registerRootComponent(Platform.OS === 'web' ? require('./preview/Preview').default : App);

// The assistant card (modules/cleft-assist AssistActivity): the phone's assistant gesture shows it over
// whatever app is open. Loaded only when that screen asks for it.
if (Platform.OS === 'android') AppRegistry.registerComponent('assist', () => require('./src/assist/AssistCard').default);
