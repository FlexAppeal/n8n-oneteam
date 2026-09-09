# n8n-oneteam

n8n community nodes for [Oneteam](https://www.oneteam.io). 
service-account tokens (`sa_…`), REST-hook webhooks, invite/update employee, memberships, feed messages.

The GitHub repo and npm package are both `n8n-oneteam`.

## What is in here

| n8n piece | What it does | Oneteam API |
| --- | --- | --- |
| Credential **Oneteam API** | `sa_…` token + optional base URL | `GET /v1/organisations` |
| **Oneteam Trigger** | Subscribe to an event | `POST/DELETE /v1/organisations/{id}/webhooks` |
| New Form Submission | Optional form filter + hydrate answers | `GET …/forms/{id}/submissions/{id}` |
| **Oneteam** → Invite / Update employee | Creates / updates a user | `POST/PUT /v2/organisations/{id}/users` |
| **Oneteam** → Membership | Add/remove network, function, team | `PUT …/users/{id}/networks\|functions\|teams` |
| **Oneteam** → Feed message | Post to the organisation feed | `POST …/organisation_messages` |

`user.anonymized` is not offered as a trigger.

## Local development

```bash
nvm use 24
npm install
npm run build
npm run start:n8n
```

`n8n@latest` (2.x) needs **Node 24** — run `nvm use 24` (or `nvm use`; `.nvmrc` pins 24) before `start:n8n`.

Open **http://localhost:5678** (not `127.0.0.1`). Local HTTP needs
`N8N_SECURE_COOKIE=false` — Safari will block the default secure cookie even on
localhost. `start:n8n` sets that and loads compiled nodes from `dist`
(`N8N_CUSTOM_EXTENSIONS=./dist` — not `.`, or n8n 2.x also scans `node_modules`).

Then add credentials:

1. Organisation Settings → Service Accounts
2. Scopes: `webhooks.manage`, `forms.view-report`, `users.create`, `users.manage`, `organisation-messages.create`
3. Token starts with `sa_`

`Base URL` defaults to `https://api.oneteam.io`. Use your API host for staging.

## Relation to other repos

- [`node-api`](https://github.com/FlexAppeal/node-api) — public API

