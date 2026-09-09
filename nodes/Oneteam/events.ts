export enum WebhookEventType {
	USER_CREATED = 'user.created',
	USER_INVITED = 'user.invited',
	USER_ACTIVATED = 'user.activated',
	USER_UPDATED = 'user.updated',
	USER_DEACTIVATED = 'user.deactivated',
	USER_ANONYMIZED = 'user.anonymized',
	USER_ONBOARDING_COMPLETED = 'user.onboarding_completed',
	FUNCTION_USER_ADDED = 'function.user_added',
	FUNCTION_USER_REMOVED = 'function.user_removed',
	NETWORK_USER_ADDED = 'network.user_added',
	NETWORK_USER_REMOVED = 'network.user_removed',
	TEAM_USER_ADDED = 'team.user_added',
	TEAM_USER_REMOVED = 'team.user_removed',
	COURSE_COMPLETED = 'course.completed',
	FORM_SUBMISSION_CREATED = 'form.submission_created',
	USER_ANNIVERSARY = 'user.anniversary',
	USER_BIRTHDAY = 'user.birthday',
	USER_CONTRACT_ENDING = 'user.contract_ending',
}

export type EventDefinition = {
	event: WebhookEventType;
	name: string;
	description: string;
};

export const WEBHOOK_EVENTS: EventDefinition[] = [
	{
		event: WebhookEventType.USER_INVITED,
		name: 'New Employee',
		description: 'An employee is invited to the organisation',
	},
	{
		event: WebhookEventType.USER_CREATED,
		name: 'Employee Created',
		description: 'An employee account is created',
	},
	{
		event: WebhookEventType.USER_ACTIVATED,
		name: 'Employee Activated',
		description: 'An employee logs in for the first time',
	},
	{
		event: WebhookEventType.USER_UPDATED,
		name: 'Employee Updated',
		description: 'An employee profile is updated',
	},
	{
		event: WebhookEventType.USER_DEACTIVATED,
		name: 'Employee Deactivated',
		description: 'An employee is deactivated or removed',
	},
	{
		event: WebhookEventType.USER_ONBOARDING_COMPLETED,
		name: 'Onboarding Completed',
		description: 'An employee completes onboarding',
	},
	{
		event: WebhookEventType.FUNCTION_USER_ADDED,
		name: 'Employee Added to Function',
		description: 'An employee is added to a function',
	},
	{
		event: WebhookEventType.FUNCTION_USER_REMOVED,
		name: 'Employee Removed From Function',
		description: 'An employee is removed from a function',
	},
	{
		event: WebhookEventType.NETWORK_USER_ADDED,
		name: 'Employee Added to Network',
		description: 'An employee is added to a network',
	},
	{
		event: WebhookEventType.NETWORK_USER_REMOVED,
		name: 'Employee Removed From Network',
		description: 'An employee is removed from a network',
	},
	{
		event: WebhookEventType.TEAM_USER_ADDED,
		name: 'Employee Added to Team',
		description: 'An employee is added to a team',
	},
	{
		event: WebhookEventType.TEAM_USER_REMOVED,
		name: 'Employee Removed From Team',
		description: 'An employee is removed from a team',
	},
	{
		event: WebhookEventType.COURSE_COMPLETED,
		name: 'Course Completed',
		description: 'An employee completes an academy course',
	},
	{
		event: WebhookEventType.FORM_SUBMISSION_CREATED,
		name: 'New Form Submission',
		description: 'A form submission is received',
	},
	{
		event: WebhookEventType.USER_ANNIVERSARY,
		name: 'Work Anniversary Approaching',
		description: '30 / 7 / 0 days before a work anniversary',
	},
	{
		event: WebhookEventType.USER_BIRTHDAY,
		name: 'Birthday Approaching',
		description: '30 / 7 / 0 days before a birthday',
	},
	{
		event: WebhookEventType.USER_CONTRACT_ENDING,
		name: 'Contract Ending',
		description: '30 / 7 / 1 days before a contract end date',
	},
];
