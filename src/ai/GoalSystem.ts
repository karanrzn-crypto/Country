import type { Goal } from './types';
import type { EntityId } from '../core/IdGenerator';

export interface GoalOwner {
  goals: Goal[];
}

/**
 * Goal management: per-agent goal list kept sorted by priority.
 * Goals are created by code or data later; the decision loop always works
 * on the highest-priority pending goals first.
 */
export class GoalSystem {
  addGoal(owner: GoalOwner, goal: Goal): void {
    owner.goals.push(goal);
    owner.goals.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  }

  /** Promotes the top pending goal to active and returns it (or null). */
  activateTop(owner: GoalOwner): Goal | null {
    const top = owner.goals.find((goal) => goal.status === 'pending');
    if (top === undefined) return null;
    (top as { status: Goal['status'] }).status = 'active';
    return top;
  }

  complete(owner: GoalOwner, goalId: EntityId): void {
    const goal = owner.goals.find((candidate) => candidate.id === goalId);
    if (goal !== undefined) {
      (goal as { status: Goal['status'] }).status = 'done';
    }
  }

  activeGoals(owner: GoalOwner): Goal[] {
    return owner.goals.filter((goal) => goal.status === 'active' || goal.status === 'pending');
  }
}
