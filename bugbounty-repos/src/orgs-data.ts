import type { ProgramConfig } from './types.js';

export interface OrgTask {
  program: string;
  org: string;
}

export function buildOrgTasks(programs: ProgramConfig[]): OrgTask[] {
  const tasks: OrgTask[] = [];

  for (const program of programs) {
    const orgs = [...new Set(program.orgs)].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    );
    for (const org of orgs) {
      tasks.push({ program: program.name, org });
    }
    console.error(`  ${program.name}: ${orgs.length} GitHub org(s)`);
  }

  return tasks;
}
