LabTrax Replit dependency hotfix

The deploy log shows: Cannot find package multer imported from server_dist/index.js

Fastest fix:
1. Upload labtrax-replit-multer-hotfix-2026-04-23.zip to the Replit project root.
2. Extract it so package.json replaces the existing package.json at /home/runner/workspace/package.json.
3. In Replit Shell, run: npm install
4. Publish again.

Alternative:
Upload/extract labtrax-full-source-part1-core-fixed-2026-04-23.zip into the project root, then run npm install.

This adds runtime dependencies multer, adm-zip, and keeps archiver.
