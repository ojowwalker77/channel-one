// What a linked computer signs to vouch for an agent, shared by the CLI, the
// web app and both relays (so nothing here touches the file system).

import { verificationCode } from "./crypto.ts";

/** Requests about machines are signed like room requests, under this fixed scope. */
export const MACHINE_SCOPE = "kiwi-machines";

/** The statement a machine signs to vouch for one agent key in one channel. */
export const vouchStatement = (roomId: string, agentPk: string) => `kiwi-vouch\n${roomId}\n${agentPk}`;

/** The code a person compares between their terminal and the browser. */
export const machineCode = (pk: string) => verificationCode(MACHINE_SCOPE, pk);
