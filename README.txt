LOCAL APP HUB
=============

WHAT IT DOES
- Opens one dashboard at http://localhost:8787
- Scans common Windows folders for Node web apps
- Recognizes apps with package.json and one of these scripts:
  dev, start, serve, preview
- Saves discovered projects as cards
- Start / Open / Stop each app
- Pin favorites
- Add a project by pasting its folder path
- Remembers the last localhost URL it detected

HOW TO USE
1. Extract this folder somewhere permanent, for example:
   C:\Users\YOURNAME\Desktop\Local-App-Hub
2. Double-click:
   START_LOCAL_APP_HUB.bat
3. Your browser opens the dashboard.
4. Click Rescan.
5. If an app is missing, click "+ Add project path" and paste the folder
   that contains that app's package.json.
6. Click Start on an app, then Open when its localhost URL appears.

NO HUB INSTALL REQUIRED
The hub itself uses only built-in Node.js modules. There is no npm install
for Local App Hub.

IMPORTANT
- Node.js must already be installed and available as "node" on PATH.
- Each project still needs its own dependencies installed if the project
  normally requires them.
- The hub does not modify your projects.
- Some unusual frameworks may not print their localhost URL in a format the
  hub can detect. In that case the app can still start; you may need to open
  its known port manually.
- If port 8787 is already used by another program, edit PORT in server.js.

FILES
- START_LOCAL_APP_HUB.bat   -> launch/open the hub
- STOP_LOCAL_APP_HUB.bat    -> shut down the hub and apps started through it
- server.js                 -> hub logic/UI
- app-hub-data.json         -> saved projects (created automatically)
