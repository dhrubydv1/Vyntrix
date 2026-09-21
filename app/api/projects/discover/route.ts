import { readdir } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/src/db";
import { projects } from "@/src/db/schema";

const PROJECTS_ROOT =
  process.env.PROJECTS_ROOT ??
  path.join(process.env.HOME ?? "", "Personal Projects");

export async function POST() {
  const entries = await readdir(PROJECTS_ROOT, {
    withFileTypes: true,
  });

  const folders = entries.filter((entry) => entry.isDirectory());

  const discoveredProjects = [];

  for (const folder of folders) {
    const projectPath = path.join(PROJECTS_ROOT, folder.name);

    const existingProject = (
      await db
        .select()
        .from(projects)
        .where(eq(projects.path, projectPath))
        .limit(1)
    )[0];

    if (existingProject) {
      discoveredProjects.push(existingProject);
      continue;
    }

    const createdProject = (
      await db
        .insert(projects)
        .values({
          name: folder.name,
          path: projectPath,
        })
        .returning()
    )[0];

    discoveredProjects.push(createdProject);
  }

  return NextResponse.json({
    root: PROJECTS_ROOT,
    projects: discoveredProjects,
  });
}
