import { createApp } from './app.js';
import { loadConfig } from './config.js';

try {
  const config=loadConfig();
  const {app,picker,media,analysis,videoQueue,movieQueue,productionQueue}=createApp(config);
  const server=app.listen(config.apiPort,'localhost',()=>{
    console.info(`AI Memories Studio API listening at http://localhost:${config.apiPort}`);
    if(!config.googleClientId||!config.googleClientSecret) console.info('Google Photos setup is incomplete. Add OAuth credentials to the root .env to connect.');
  });
  for(const signal of ['SIGTERM','SIGINT'] as const) process.once(signal,()=>{
    const deadline=setTimeout(()=>process.exit(0),10000);deadline.unref();
    void Promise.allSettled([picker.dispose(),analysis.dispose(),videoQueue.dispose(),movieQueue.dispose(),productionQueue.dispose()]).finally(()=>{server.close(()=>{media.db.close();process.exit(0);});});
  });
  server.on('error',()=>{console.error('The API could not listen. Check API_PORT and whether another server is running.');process.exit(1);});
} catch(error) {
  console.error(error instanceof Error && error.message.startsWith('Invalid environment') ? error.message : 'The API could not start. Check .env, storage permissions, and the README.');
  process.exit(1);
}
