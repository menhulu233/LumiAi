import { app } from 'electron';
import { APP_NAME } from './appConstants';
import { configureUserDataPath } from './utils/paths';
import { initApp } from './core/lifecycle';
import { setupAppEventHandlers } from './core/app';

app.name = APP_NAME;
app.setName(APP_NAME);
configureUserDataPath();
setupAppEventHandlers();
initApp().catch(console.error);
