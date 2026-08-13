import { getDb } from "../src/db";
import { seedOrganizationRegistryFromEmployerSources } from "../src/db/employerRegistrySeedCore";

const db = getDb();
const before = (db.prepare("SELECT COUNT(*) AS count FROM organizations").get() as { count: number })
  .count;
const stats = seedOrganizationRegistryFromEmployerSources(db);
const after = (db.prepare("SELECT COUNT(*) AS count FROM organizations").get() as { count: number })
  .count;

console.log(JSON.stringify({ organizationsBefore: before, organizationsAfter: after, ...stats }, null, 2));
