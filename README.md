# BoostBot

**BoostBot** is a Discord bot that automatically assigns a VIP role to users who boost your server and removes it when they stop. It also logs those changes and can do a full synchronization on demand.

---

## Table of Contents

- [Features](#features)  
- [Getting Started](#getting-started)  
- [Usage](#usage)  
- [Permissions & Setup](#permissions--setup)  
- [Troubleshooting](#troubleshooting)  
- [Contributing & Testing](#contributing--testing)  
- [License](#license)

---

## Features
- Automatically gives VIP roles when users start boosting.
- Removes the VIP role when users stop boosting.
- Logs boost activity in a channel you choose.
- Offers a `/setup` wizard, as well as `/setlog`, `/setviprole`, and `/reconcile` commands.

---

## Getting Started

### Clone the repo:
```bash
git clone https://github.com/sydlexxia/boostBot.git 
cd boostbot
npm install

