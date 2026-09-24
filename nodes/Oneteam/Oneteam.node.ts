import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeListSearchResult,
	INodeProperties,
	INodePropertyOptions,
	IHttpRequestMethods,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	apiRecord,
	formAndCourseSearch,
	getOrganisation,
	listAllPages,
	listPage,
	listResourceOptions,
	locatorId,
	oneteamApiRequest,
	organisationPath,
	searchListedResource,
	searchLocator,
} from './GenericFunctions';

const pagedLists = {
	resource: ['form', 'task', 'course', 'onboarding', 'survey'],
	operation: ['list', 'listSubmissions', 'userProgress', 'feedback'],
};

const analyticsUsersPageSize = 25;
// Safety stop for offset paging. A full page keeps requesting the next one.
const analyticsUsersMaxOffset = 10000;

const analyticsTimeSeriesMetrics = [
	{ name: 'Private Messages Created', value: 'private_message.created' },
	{ name: 'Feed Messages Created', value: 'feed_message.created' },
	{ name: 'High Fives Created', value: 'highfive.created' },
	{ name: 'Comments Created', value: 'comment.created' },
	{ name: 'Users Active', value: 'users.active' },
	{ name: 'Users Invited', value: 'users.invited' },
	{ name: 'Users Registered', value: 'users.registered' },
	{ name: 'Exchanges Created', value: 'exchanges.created' },
	{ name: 'Exchanges Approved', value: 'exchanges.approved' },
	{
		name: 'Exchanges Approved Time',
		value: 'exchanges.total_approved_time_in_seconds',
	},
];

const taskIconOptions = [
	'account-circle',
	'account-tree',
	'analytics',
	'assignment',
	'business',
	'cake',
	'calendar-today',
	'clothes',
	'coffee',
	'email',
	'favorite',
	'flight',
	'folder',
	'lock',
	'medical-cross',
	'money',
	'school',
	'settings',
	'shield',
	'signature',
].map((icon) => ({
	name: icon
		.split('-')
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' '),
	value: `default/forms/${icon}.png`,
}));

const weekdayOptions = [
	{ name: 'Sunday', value: 0 },
	{ name: 'Monday', value: 1 },
	{ name: 'Tuesday', value: 2 },
	{ name: 'Wednesday', value: 3 },
	{ name: 'Thursday', value: 4 },
	{ name: 'Friday', value: 5 },
	{ name: 'Saturday', value: 6 },
];

const taskAdvanced = {
	resource: ['task'],
	operation: ['create'],
};

const directMessage = {
	resource: ['notification', 'chatMessage'],
	operation: ['send'],
};

const statusUpdate = {
	resource: ['form', 'task'],
	operation: ['updateSubmissionStatus', 'updateStatus'],
};

function directRecipientBody(
	context: IExecuteFunctions,
	itemIndex: number,
): IDataObject {
	const recipientType = context.getNodeParameter(
		'recipientType',
		itemIndex,
	) as string;
	if (recipientType === 'externalId') {
		return {
			external_id: context.getNodeParameter('recipientExternalId', itemIndex),
		};
	}
	if (recipientType === 'email') {
		return { email: context.getNodeParameter('recipientEmail', itemIndex) };
	}
	return { user_id: context.getNodeParameter('recipientUserId', itemIndex) };
}

function taskScheduleBody(
	context: IExecuteFunctions,
	itemIndex: number,
): IDataObject {
	const repeat = context.getNodeParameter('scheduleRepeat', itemIndex) as string;
	const schedule: IDataObject = {
		repeat,
		time_of_day: (
			context.getNodeParameter('scheduleTimeOfDay', itemIndex) as string
		).trim(),
	};

	if (repeat === 'weekly') {
		const daysOfWeek = context.getNodeParameter(
			'scheduleDaysOfWeek',
			itemIndex,
		) as number[];

		if (daysOfWeek.length === 0) {
			throw new NodeOperationError(
				context.getNode(),
				'Pick at least one day of the week for a weekly task',
				{ itemIndex },
			);
		}

		schedule.days_of_week = [...daysOfWeek].sort((a, b) => a - b);
	}

	if (repeat === 'monthly') {
		const pattern = context.getNodeParameter(
			'scheduleMonthlyPattern',
			itemIndex,
		) as string;
		schedule.monthly_pattern = pattern;

		if (pattern === 'day_of_month') {
			schedule.day_of_month = context.getNodeParameter(
				'scheduleDayOfMonth',
				itemIndex,
			);
		} else {
			schedule.nth_weekday = {
				nth:
					pattern === 'last_weekday'
						? -1
						: context.getNodeParameter('scheduleNth', itemIndex),
				weekday: context.getNodeParameter('scheduleWeekday', itemIndex),
			};
		}
	}

	if (repeat === 'every_n_days') {
		schedule.interval = context.getNodeParameter('scheduleInterval', itemIndex);
	}

	return schedule;
}

function taskSettingsBody(
	context: IExecuteFunctions,
	itemIndex: number,
): IDataObject {
	const cadence = context.getNodeParameter('cadence', itemIndex) as string;
	const audienceMode = context.getNodeParameter(
		'audienceMode',
		itemIndex,
	) as string;
	const settings: IDataObject = {
		cadence,
		audience_mode: audienceMode,
	};

	// instance_scope is required for team tasks and rejected for individual ones
	if (audienceMode === 'team') {
		settings.instance_scope = context.getNodeParameter(
			'instanceScope',
			itemIndex,
		);
	}

	if (cadence === 'one_time') {
		const startsAt = context.getNodeParameter('startsAt', itemIndex) as string;
		const deadlineAt = context.getNodeParameter(
			'deadlineAt',
			itemIndex,
		) as string;

		if (!startsAt || !deadlineAt) {
			throw new NodeOperationError(
				context.getNode(),
				'Set both Starts At and Deadline At for a one-time task',
				{ itemIndex },
			);
		}

		if (new Date(deadlineAt) <= new Date(startsAt)) {
			throw new NodeOperationError(
				context.getNode(),
				'Deadline At must be later than Starts At',
				{ itemIndex },
			);
		}

		settings.starts_at = startsAt;
		settings.deadline_at = deadlineAt;

		return settings;
	}

	settings.schedule = taskScheduleBody(context, itemIndex);
	settings.deadline_after = {
		value: context.getNodeParameter('deadlineAfterValue', itemIndex),
		unit: context.getNodeParameter('deadlineAfterUnit', itemIndex),
	};

	return settings;
}

// Oneteam ids are numeric strings; the audience write schema expects numbers
function audienceValue(value: string): string | number {
	const trimmed = value.trim();
	return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

function taskAudienceBody(
	context: IExecuteFunctions,
	itemIndex: number,
): IDataObject | undefined {
	const networkIds = context.getNodeParameter(
		'audienceNetworkIds',
		itemIndex,
	) as string[];
	const functionIds = context.getNodeParameter(
		'audienceFunctionIds',
		itemIndex,
	) as string[];
	const userIds = (
		(
			context.getNodeParameter('audienceUsers', itemIndex, {}) as {
				user?: Array<{ id: unknown }>;
			}
		).user ?? []
	)
		.map((row) => locatorId(row.id))
		.filter(Boolean);

	const instanceScope =
		(context.getNodeParameter('audienceMode', itemIndex) as string) === 'team'
			? (context.getNodeParameter('instanceScope', itemIndex) as string)
			: 'organisation';

	if (instanceScope === 'network' && networkIds.length === 0) {
		throw new NodeOperationError(
			context.getNode(),
			'A task with one instance per network needs at least one network in its audience',
			{ itemIndex },
		);
	}

	const groups: Array<[string, string[]]> = [
		['membership.networks.id', networkIds],
		['membership.functions.id', functionIds],
		['users.id', userIds],
	];
	const predicates: IDataObject[] = [];

	for (const [attribute, values] of groups) {
		if (values.length === 0) continue;
		predicates.push({
			attribute,
			comparison: 'in',
			value: values.map(audienceValue),
		});
	}

	// No predicates means every employee in the organisation
	if (predicates.length === 0) return undefined;

	return {
		predicate_type: context.getNodeParameter('audiencePredicateType', itemIndex),
		predicates,
	};
}

function optionLines(value: string): Array<{ value: string }> {
	return value
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => ({ value: line }));
}

function questionOptions(question: IDataObject): Array<{ value: string }> {
	const collection = question.optionList as
		| { option?: IDataObject[] }
		| undefined;
	const rows = collection?.option ?? [];
	const options = rows.flatMap((row) => optionLines(String(row.value ?? '')));

	// Workflows built before the Options list was repeatable stored one per line
	if (options.length === 0) {
		return optionLines(String(question.options ?? ''));
	}

	return options;
}

function taskQuestionBodies(
	context: IExecuteFunctions,
	itemIndex: number,
): IDataObject[] {
	const collection = context.getNodeParameter('taskQuestions', itemIndex) as {
		question?: Array<IDataObject>;
	};
	const questions = collection.question ?? [];
	const payloads: IDataObject[] = [];

	for (const question of questions) {
		const type = String(question.type);
		const text = String(question.text ?? '').trim();

		if (!text) {
			throw new NodeOperationError(
				context.getNode(),
				'Each question needs a title',
				{ itemIndex },
			);
		}

		const settings: IDataObject = {
			answer_required: Boolean(question.answerRequired),
		};
		const payload: IDataObject = { type, text, settings };

		if (type === 'question_checklist' || type === 'question_dropdown') {
			const options = questionOptions(question);

			if (options.length === 0) {
				throw new NodeOperationError(
					context.getNode(),
					type === 'question_dropdown'
						? `The dropdown "${text}" needs at least one option`
						: `The checklist "${text}" needs at least one option`,
					{ itemIndex },
				);
			}

			payload.options = options;
		}

		if (type === 'question_boolean') {
			settings.label_true = String(question.labelTrue ?? 'Yes').trim() || 'Yes';
			settings.label_false = String(question.labelFalse ?? 'No').trim() || 'No';
		}

		if (type === 'question_slider') {
			settings.amount_of_steps = Number(question.amountOfSteps ?? 5);
			settings.label_left = String(question.labelLeft ?? '');
			settings.label_center = String(question.labelCenter ?? '');
			settings.label_right = String(question.labelRight ?? '');
		}

		if (type === 'question_datetime') {
			settings.allow_date_select = question.allowDateSelect !== false;
			settings.allow_time_select = question.allowTimeSelect !== false;

			if (!settings.allow_date_select && !settings.allow_time_select) {
				throw new NodeOperationError(
					context.getNode(),
					'A date and time question needs date, time, or both',
					{ itemIndex },
				);
			}
		}

		if (type === 'question_file_upload') {
			settings.allow_multiple_uploads = Boolean(question.allowMultipleUploads);
		}

		payloads.push({ question: payload });
	}

	return payloads;
}

async function deleteDraftTask(
	context: IExecuteFunctions,
	organisationId: string,
	taskId: string,
): Promise<void> {
	try {
		await oneteamApiRequest.call(
			context,
			'DELETE',
			organisationPath(organisationId, `forms/${taskId}`),
		);
	} catch {
		// Keep the original failure as the error the user sees
	}
}

function asRecord(value: unknown): IDataObject | undefined {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return value as IDataObject;
	}

	return undefined;
}

function records(value: unknown): IDataObject[] {
	if (!Array.isArray(value)) return [];

	return value.flatMap((item) => {
		const record = asRecord(item);

		return record ? [record] : [];
	});
}

function personName(source: IDataObject | undefined): string {
	if (!source) return '';

	const full = source.full_name;
	if (typeof full === 'string' && full.trim()) return full.trim();

	return [source.first_name, source.last_name]
		.filter((part) => typeof part === 'string' && part.trim())
		.join(' ');
}

// Individual tasks name the assignee. Team tasks name the people who filled
// the instance, or the network when nobody has yet.
function audienceLabel(submission: IDataObject): string {
	const filledBy = records(asRecord(submission.filled_by)?.users)
		.map(personName)
		.filter(Boolean)
		.join(', ');

	if (filledBy) return filledBy;

	const assignee = personName(asRecord(submission.user));
	if (assignee) return assignee;

	return records(asRecord(submission.meta_data)?.networks)
		.map((network) => String(network.name ?? '').trim())
		.filter(Boolean)
		.join(', ');
}

// Tasks come back grouped by schedule period. Forms come back as plain rows.
function submissionOptions(rows: IDataObject[]): INodePropertyOptions[] {
	const groups = rows.filter((row) => Array.isArray(row.instances));
	const entries = groups.length
		? groups.flatMap((group) => {
				const opensAt = group.opens_at;
				const period =
					groups.length > 1 && typeof opensAt === 'string'
						? opensAt.slice(0, 10)
						: '';

				return records(group.instances).map((row) => ({ row, period }));
			})
		: rows.map((row) => ({ row, period: '' }));

	return entries
		.flatMap(({ row, period }) => {
			const id = row.id;
			if (id === undefined || id === null || id === '') return [];

			const who = audienceLabel(row) || String(id);

			return [
				{
					name: period ? `${who} — ${period}` : who,
					value: String(id),
					period,
				},
			];
		})
		.sort(
			(left, right) =>
				right.period.localeCompare(left.period) ||
				left.name.localeCompare(right.name),
		)
		.map(({ name, value }) => ({ name, value }));
}

function reportDateRange(
	context: IExecuteFunctions,
	itemIndex: number,
): { query: IDataObject; body: IDataObject } {
	const dateRangeType = context.getNodeParameter(
		'dateRangeType',
		itemIndex,
	) as string;
	if (dateRangeType === 'all') {
		return { query: { date_range_type: 'all' }, body: { type: 'all' } };
	}
	if (dateRangeType === 'custom') {
		const fromDate = context.getNodeParameter('fromDate', itemIndex) as string;
		const toDate = context.getNodeParameter('toDate', itemIndex) as string;
		return {
			query: {
				date_range_type: 'custom',
				date_range_from: fromDate.slice(0, 10),
				date_range_to: toDate.slice(0, 10),
			},
			body: {
				type: 'custom',
				from: fromDate.slice(0, 10),
				to: toDate.slice(0, 10),
			},
		};
	}
	const days = Number(dateRangeType);
	return {
		query: { date_range_type: 'rolling', date_range_days: days },
		body: { type: 'rolling', days },
	};
}

function parameterId(
	context: IExecuteFunctions,
	name: string,
	itemIndex: number,
): string {
	return context.getNodeParameter(name, itemIndex, '', {
		extractValue: true,
	}) as string;
}

function pushApiRecord(
	returnData: INodeExecutionData[],
	response: IDataObject,
): void {
	returnData.push({ json: apiRecord(response) });
}

async function pushRequest(
	context: IExecuteFunctions,
	returnData: INodeExecutionData[],
	method: IHttpRequestMethods,
	path: string,
	body: IDataObject = {},
	qs: IDataObject = {},
): Promise<void> {
	const response = await oneteamApiRequest.call(context, method, path, body, qs);
	pushApiRecord(returnData, response);
}

function operationField(
	resource: string,
	options: INodeProperties['options'],
	defaultValue: string,
): INodeProperties {
	return {
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [resource] } },
		options,
		default: defaultValue,
	};
}

function pushAnalyticsRows(
	returnData: INodeExecutionData[],
	response: IDataObject,
): void {
	const rows = response.data;
	if (!Array.isArray(rows)) {
		if (rows && typeof rows === 'object' && Object.keys(rows).length > 0) {
			returnData.push({ json: rows as IDataObject });
		}
		return;
	}

	for (const row of rows) {
		if (row && typeof row === 'object' && Object.keys(row).length > 0) {
			returnData.push({ json: row as IDataObject });
		}
	}
}

async function pushAnalyticsUsers(
	context: IExecuteFunctions,
	returnData: INodeExecutionData[],
	itemIndex: number,
	path: string,
	qs: IDataObject,
): Promise<void> {
	const returnAll = context.getNodeParameter('returnAll', itemIndex) as boolean;
	const limit = analyticsUsersPageSize;
	let offset = 0;

	do {
		const response = await oneteamApiRequest.call(context, 'GET', path, {}, {
			...qs,
			limit,
			offset,
		});
		const metricRows = Array.isArray(response.data) ? response.data : [];
		let pageCount = 0;

		for (const metricRow of metricRows) {
			const row = metricRow as IDataObject;
			const list = Array.isArray(row.list) ? row.list : [];
			pageCount = Math.max(pageCount, list.length);
			for (const entry of list) {
				returnData.push({
					json: {
						metric_type: row.metric_type,
						...(entry as IDataObject),
					},
				});
			}
		}

		if (!returnAll || pageCount < limit) break;
		offset += limit;
	} while (offset < analyticsUsersMaxOffset);
}

async function pushListedRows(
	context: IExecuteFunctions,
	returnData: INodeExecutionData[],
	itemIndex: number,
	path: string,
	qs: IDataObject = {},
): Promise<void> {
	const returnAll = context.getNodeParameter('returnAll', itemIndex) as boolean;
	if (returnAll) {
		const rows = await listAllPages.call(context, path, qs);
		for (const row of rows) {
			returnData.push({ json: row });
		}
		return;
	}

	const nextPage = (
		context.getNodeParameter('nextPage', itemIndex) as string
	).trim();
	const page = await listPage.call(
		context,
		path,
		qs,
		nextPage || undefined,
	);
	for (const row of page.rows) {
		returnData.push({ json: { ...row, nextPage: page.nextPage } });
	}
}

export class Oneteam implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Oneteam',
		name: 'oneteam',
		icon: 'file:oneteam.png',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Run operations in Oneteam',
		defaults: {
			name: 'Oneteam',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'oneteamApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Employee', value: 'employee' },
					{ name: 'Organization Message', value: 'feedMessage' },
					{ name: 'Membership', value: 'membership' },
					{ name: 'Form', value: 'form' },
					{ name: 'Task', value: 'task' },
					{ name: 'Push Notification', value: 'notification' },
					{ name: 'Chat Message', value: 'chatMessage' },
					{ name: 'Course', value: 'course' },
					{ name: 'Onboarding', value: 'onboarding' },
					{ name: 'Analytics', value: 'analytics' },
					{ name: 'Survey', value: 'survey' },
					{ name: 'Performance', value: 'performance' },
				],
				default: 'employee',
			},
			operationField(
				'employee',
				[
					{
						name: 'Invite',
						value: 'invite',
						action: 'Invite an employee',
						description: 'Invite a new employee to the organisation',
					},
					{
						name: 'Update',
						value: 'update',
						action: 'Update an employee',
						description: 'Update an existing employee profile',
					},
				],
				'invite',
			),
			operationField(
				'feedMessage',
				[
					{
						name: 'Create',
						value: 'create',
						action: 'Create an organization message',
						description: 'Create an organization message',
					},
				],
				'create',
			),
			operationField(
				'membership',
				[
					{
						name: 'Add or Remove',
						value: 'update',
						action: 'Add or remove an employee membership',
						description:
							'Add or remove an employee from a network, function or team',
					},
				],
				'update',
			),
			operationField(
				'form',
				[
					{
						name: 'List',
						value: 'list',
						action: 'List forms',
						description: 'List forms in the organisation',
					},
					{
						name: 'List Submissions',
						value: 'listSubmissions',
						action: 'List form submissions',
						description: 'List submissions for a form',
					},
					{
						name: 'Get Submission',
						value: 'getSubmission',
						action: 'Get a form submission',
						description: 'Get one form submission including answers',
					},
					{
						name: 'Update Submission Status',
						value: 'updateSubmissionStatus',
						action: 'Update form submission status',
						description: 'Set the response status of a form submission',
					},
				],
				'list',
			),
			operationField(
				'task',
				[
					{
						name: 'List',
						value: 'list',
						action: 'List tasks',
						description: 'List tasks in the organisation',
					},
					{
						name: 'Create',
						value: 'create',
						action: 'Create a task',
						description:
							'Create a one-time or recurring task for an audience, like the Oneteam admin does',
					},
					{
						name: 'Update Status',
						value: 'updateStatus',
						action: 'Update task status',
						description: 'Set the response status of a task submission',
					},
				],
				'create',
			),
			operationField(
				'notification',
				[
					{
						name: 'Send',
						value: 'send',
						action: 'Send a push notification',
						description: 'Send a push notification to one employee',
					},
				],
				'send',
			),
			operationField(
				'chatMessage',
				[
					{
						name: 'Send',
						value: 'send',
						action: 'Send a chat message',
						description: 'Send a private chat message to one employee',
					},
				],
				'send',
			),
			operationField(
				'course',
				[
					{
						name: 'List',
						value: 'list',
						action: 'List courses',
						description: 'List academy courses',
					},
					{
						name: 'Get Statistics',
						value: 'statistics',
						action: 'Get course statistics',
						description: 'Get completion statistics for one course',
					},
					{
						name: 'List Progress',
						value: 'userProgress',
						action: 'List course progress',
						description: 'List learner progress for one course',
					},
					{
						name: 'List Feedback',
						value: 'feedback',
						action: 'List course feedback',
						description: 'List ratings and comments for one course',
					},
				],
				'list',
			),
			operationField(
				'onboarding',
				[
					{
						name: 'Get Statistics',
						value: 'statistics',
						action: 'Get onboarding statistics',
						description: 'Get the organisation onboarding overview',
					},
					{
						name: 'List User Progress',
						value: 'userProgress',
						action: 'List onboarding user progress',
						description: 'List onboarding progress per employee',
					},
				],
				'statistics',
			),
			operationField(
				'survey',
				[
					{
						name: 'List',
						value: 'list',
						action: 'List surveys',
						description: 'List surveys in the organisation',
					},
					{
						name: 'Get Report',
						value: 'report',
						action: 'Get a survey report',
						description: 'Get the report for one survey',
					},
				],
				'list',
			),
			operationField(
				'performance',
				[
					{
						name: 'Get Summary',
						value: 'summary',
						action: 'Get the performance summary',
						description: 'Get the performance review summary',
					},
				],
				'summary',
			),
			operationField(
				'analytics',
				[
					{
						name: 'Get',
						value: 'get',
						action: 'Get organisation analytics',
						description: 'Get organisation analytics for selected metrics',
					},
					{
						name: 'Get Counts',
						value: 'counts',
						action: 'Get analytics counts',
						description: 'Get organisation analytics counts',
					},
					{
						name: 'List Users',
						value: 'users',
						action: 'List analytics users',
						description: 'List users behind the selected metrics',
					},
					{
						name: 'Get Networks',
						value: 'networks',
						action: 'Get network analytics',
						description: 'Get analytics for each network',
					},
					{
						name: 'List Catalog',
						value: 'catalog',
						action: 'List the metric catalog',
						description:
							'List the metrics you can use in Run Report, including Feed, Chat, and eLearning',
					},
					{
						name: 'List Reports',
						value: 'reports',
						action: 'List saved reports',
						description: 'List saved dashboard reports and their results',
					},
					{
						name: 'Run Report',
						value: 'run',
						action: 'Run a metric report',
						description: 'Run one metric from the catalog for a date range',
					},
				],
				'get',
			),
			{
				displayName: 'First Name',
				name: 'firstName',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: { resource: ['employee'], operation: ['invite'] },
				},
			},
			{
				displayName: 'Last Name',
				name: 'lastName',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: { resource: ['employee'], operation: ['invite'] },
				},
			},
			{
				displayName: 'Email',
				name: 'email',
				type: 'string',
				placeholder: 'jane.doe@example.com',
				required: true,
				default: '',
				displayOptions: {
					show: { resource: ['employee'], operation: ['invite'] },
				},
			},
			{
				displayName: 'External ID',
				name: 'externalId',
				type: 'string',
				default: '',
				description: 'The employee id in your HR system',
				displayOptions: {
					show: { resource: ['employee'], operation: ['invite'] },
				},
			},
			{
				displayName: 'Language',
				name: 'languageLocale',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getLanguages' },
				default: '',
				displayOptions: {
					show: { resource: ['employee'], operation: ['invite'] },
				},
			},
			{
				displayName: 'Employee ID',
				name: 'userId',
				type: 'string',
				required: true,
				default: '',
				description:
					'Map this from a previous trigger, for example data.user.id',
				displayOptions: {
					show: {
						resource: ['employee', 'membership'],
						operation: ['update'],
					},
				},
			},
			{
				displayName: 'First Name',
				name: 'firstName',
				type: 'string',
				default: '',
				displayOptions: {
					show: { resource: ['employee'], operation: ['update'] },
				},
			},
			{
				displayName: 'Last Name',
				name: 'lastName',
				type: 'string',
				default: '',
				displayOptions: {
					show: { resource: ['employee'], operation: ['update'] },
				},
			},
			{
				displayName: 'Email',
				name: 'email',
				type: 'string',
				default: '',
				displayOptions: {
					show: { resource: ['employee'], operation: ['update'] },
				},
			},
			{
				displayName: 'External ID',
				name: 'externalId',
				type: 'string',
				default: '',
				displayOptions: {
					show: { resource: ['employee'], operation: ['update'] },
				},
			},
			{
				displayName: 'Phone Number',
				name: 'phoneNum',
				type: 'string',
				default: '',
				displayOptions: {
					show: { resource: ['employee'], operation: ['update'] },
				},
			},
			{
				displayName: 'Dial Code',
				name: 'dialCode',
				type: 'string',
				default: '',
				description: 'Country calling code, for example +31',
				displayOptions: {
					show: { resource: ['employee'], operation: ['update'] },
				},
			},
			{
				displayName: 'Message',
				name: 'text',
				type: 'string',
				typeOptions: { rows: 4 },
				required: true,
				default: '',
				displayOptions: {
					show: { resource: ['feedMessage'], operation: ['create'] },
				},
			},
			{
				displayName: 'Mark as Important',
				name: 'isImportant',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: { resource: ['feedMessage'], operation: ['create'] },
				},
			},
			{
				displayName: 'Publish At',
				name: 'publishAt',
				type: 'dateTime',
				default: '',
				description: 'Schedule the message instead of publishing immediately',
				displayOptions: {
					show: { resource: ['feedMessage'], operation: ['create'] },
				},
			},
			{
				displayName: 'Kind',
				name: 'kind',
				type: 'options',
				options: [
					{ name: 'Network', value: 'networks' },
					{ name: 'Function', value: 'functions' },
					{ name: 'Team', value: 'teams' },
				],
				default: 'networks',
				displayOptions: {
					show: { resource: ['membership'], operation: ['update'] },
				},
			},
			{
				displayName: 'Network',
				name: 'networkId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getNetworks' },
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['membership'],
						operation: ['update'],
						kind: ['networks'],
					},
				},
			},
			{
				displayName: 'Function',
				name: 'functionId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getFunctions' },
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['membership'],
						operation: ['update'],
						kind: ['functions'],
					},
				},
			},
			{
				displayName: 'Team',
				name: 'teamId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getTeams' },
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['membership'],
						operation: ['update'],
						kind: ['teams'],
					},
				},
			},
			{
				displayName: 'Action',
				name: 'action',
				type: 'options',
				options: [
					{ name: 'Add', value: 'add' },
					{ name: 'Remove', value: 'remove' },
				],
				default: 'add',
				displayOptions: {
					show: { resource: ['membership'], operation: ['update'] },
				},
			},
			searchLocator('Course', 'courseId', 'searchCourses', {
				description: 'Search by name, or paste an ID',
				displayOptions: {
					show: {
						resource: ['course'],
						operation: ['statistics', 'userProgress', 'feedback'],
					},
				},
			}),
			searchLocator('Survey', 'surveyId', 'searchSurveys', {
				description:
					'Search by title (3+ characters) or paste an ID. The list loads one page at a time.',
				idPlaceholder: 'Survey ID',
				displayOptions: {
					show: { resource: ['survey'], operation: ['report'] },
				},
			}),
			{
				displayName: 'Chart',
				name: 'chartType',
				type: 'options',
				default: 'line',
				options: [
					{ name: 'Line', value: 'line' },
					{ name: 'Bar', value: 'bar' },
					{ name: 'Area', value: 'area' },
					{ name: 'Pie', value: 'pie' },
					{ name: 'KPI', value: 'kpi' },
					{ name: 'Gauge', value: 'gauge' },
				],
				displayOptions: {
					show: { resource: ['analytics'], operation: ['run'] },
				},
			},
			{
				displayName: 'Metric Key',
				name: 'metricKey',
				type: 'string',
				required: true,
				default: '',
				description: 'Key from List Catalog, for example feed.messages_created',
				displayOptions: {
					show: { resource: ['analytics'], operation: ['run'] },
				},
			},
			{
				displayName: 'Date Range',
				name: 'dateRangeType',
				type: 'options',
				default: 'rolling',
				options: [
					{ name: 'Last 7 Days', value: '7' },
					{ name: 'Last 30 Days', value: '30' },
					{ name: 'Last 90 Days', value: '90' },
					{ name: 'Last 365 Days', value: '365' },
					{ name: 'All Time', value: 'all' },
					{ name: 'Custom', value: 'custom' },
				],
				displayOptions: {
					show: { resource: ['analytics'], operation: ['run', 'reports'] },
				},
			},
			searchLocator('Form Name or ID', 'formId', 'searchForms', {
				description: 'Search by title (3+ characters), or paste an ID',
				displayOptions: {
					show: {
						resource: ['form'],
						operation: ['listSubmissions', 'getSubmission'],
					},
				},
			}),
			{
				displayName: 'Submission ID',
				name: 'submissionId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: { resource: ['form'], operation: ['getSubmission'] },
				},
			},
			{
				displayName: 'Metrics',
				name: 'metrics',
				type: 'multiOptions',
				required: true,
				default: ['users.active'],
				options: analyticsTimeSeriesMetrics,
				displayOptions: {
					show: { resource: ['analytics'], operation: ['get'] },
				},
			},
			{
				displayName: 'Metrics',
				name: 'metrics',
				type: 'multiOptions',
				required: true,
				default: ['users.registered'],
				description:
					'Current totals only. Active users and messages are on Get, not here.',
				options: [
					{ name: 'Users Invited', value: 'users.invited' },
					{ name: 'Users Registered', value: 'users.registered' },
					{ name: 'Users Pending', value: 'users.pending' },
				],
				displayOptions: {
					show: { resource: ['analytics'], operation: ['counts'] },
				},
			},
			{
				displayName: 'Metrics',
				name: 'metrics',
				type: 'multiOptions',
				required: true,
				default: ['exchanges.created'],
				description:
					'Only exchange metrics return a user list. Active users stay on Get.',
				options: [
					{ name: 'Exchanges Created', value: 'exchanges.created' },
					{ name: 'Exchanges Approved', value: 'exchanges.approved' },
				],
				displayOptions: {
					show: { resource: ['analytics'], operation: ['users'] },
				},
			},
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				default: true,
				description:
					'Load every page of 25 users. Turn this off to load the first page.',
				displayOptions: {
					show: { resource: ['analytics'], operation: ['users'] },
				},
			},
			{
				displayName: 'From Date',
				name: 'fromDate',
				type: 'dateTime',
				default: '',
				description: 'Leave empty to use the start of the current month',
				displayOptions: {
					show: {
						resource: ['analytics'],
						operation: ['get', 'users', 'networks'],
					},
				},
			},
			{
				displayName: 'From Date',
				name: 'fromDate',
				type: 'dateTime',
				default: '',
				displayOptions: {
					show: {
						resource: ['analytics'],
						operation: ['run', 'reports'],
						dateRangeType: ['custom'],
					},
				},
			},
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				default: true,
				description:
					'Load every page. Turn this off to load one page at a time.',
				displayOptions: { show: pagedLists },
			},
			{
				displayName: 'Next Page',
				name: 'nextPage',
				type: 'string',
				default: '',
				description:
					'Leave empty for the first page. To load the following page, use the Next Page value from the previous run. It is a code from Oneteam — copy it as-is.',
				displayOptions: {
					show: { ...pagedLists, returnAll: [false] },
				},
			},
			{
				displayName: 'To Date',
				name: 'toDate',
				type: 'dateTime',
				default: '',
				description: 'Leave empty to use the end of the current month',
				displayOptions: {
					show: {
						resource: ['analytics'],
						operation: ['get', 'users', 'networks'],
					},
				},
			},
			{
				displayName: 'To Date',
				name: 'toDate',
				type: 'dateTime',
				default: '',
				displayOptions: {
					show: {
						resource: ['analytics'],
						operation: ['run', 'reports'],
						dateRangeType: ['custom'],
					},
				},
			},
			{
				displayName: 'Title',
				name: 'title',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: taskAdvanced },
			},
			{
				displayName: 'Heading',
				name: 'heading',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: { resource: ['notification'], operation: ['send'] },
				},
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				typeOptions: { rows: 4 },
				required: true,
				default: '',
				displayOptions: { show: directMessage },
			},
			{
				displayName: 'Attachment ID',
				name: 'attachmentId',
				type: 'string',
				default: '',
				description:
					'Optional Oneteam file id. Upload the file in Oneteam first; this action does not upload a file from n8n.',
				displayOptions: {
					show: { resource: ['chatMessage'], operation: ['send'] },
				},
			},
			{
				displayName: 'Repeat',
				name: 'cadence',
				type: 'options',
				default: 'one_time',
				options: [
					{ name: 'One Time', value: 'one_time' },
					{ name: 'Recurring', value: 'recurring' },
				],
				displayOptions: { show: taskAdvanced },
			},
			{
				displayName: 'Starts At',
				name: 'startsAt',
				type: 'dateTime',
				required: true,
				default: '',
				displayOptions: {
					show: { ...taskAdvanced, cadence: ['one_time'] },
				},
			},
			{
				displayName: 'Deadline At',
				name: 'deadlineAt',
				type: 'dateTime',
				required: true,
				default: '',
				description: 'Shown to employees as the deadline of the task',
				displayOptions: {
					show: { ...taskAdvanced, cadence: ['one_time'] },
				},
			},
			{
				displayName: 'Repeats Every',
				name: 'scheduleRepeat',
				type: 'options',
				default: 'daily',
				options: [
					{ name: 'Day', value: 'daily' },
					{ name: 'Week', value: 'weekly' },
					{ name: 'Month', value: 'monthly' },
					{ name: 'Number of Days', value: 'every_n_days' },
				],
				displayOptions: {
					show: { ...taskAdvanced, cadence: ['recurring'] },
				},
			},
			{
				displayName: 'Time of Day',
				name: 'scheduleTimeOfDay',
				type: 'string',
				default: '09:00',
				placeholder: '09:00',
				description:
					'Local time in the timezone of the organisation admin profile',
				displayOptions: {
					show: { ...taskAdvanced, cadence: ['recurring'] },
				},
			},
			{
				displayName: 'Days of the Week',
				name: 'scheduleDaysOfWeek',
				type: 'multiOptions',
				default: [1],
				options: weekdayOptions,
				displayOptions: {
					show: {
						...taskAdvanced,
						cadence: ['recurring'],
						scheduleRepeat: ['weekly'],
					},
				},
			},
			{
				displayName: 'Monthly On',
				name: 'scheduleMonthlyPattern',
				type: 'options',
				default: 'day_of_month',
				options: [
					{ name: 'Day of the Month', value: 'day_of_month' },
					{ name: 'Weekday of the Month', value: 'nth_weekday' },
					{ name: 'Last Weekday of the Month', value: 'last_weekday' },
				],
				displayOptions: {
					show: {
						...taskAdvanced,
						cadence: ['recurring'],
						scheduleRepeat: ['monthly'],
					},
				},
			},
			{
				displayName: 'Day of the Month',
				name: 'scheduleDayOfMonth',
				type: 'number',
				default: 1,
				typeOptions: { minValue: 1, maxValue: 31 },
				displayOptions: {
					show: {
						...taskAdvanced,
						cadence: ['recurring'],
						scheduleRepeat: ['monthly'],
						scheduleMonthlyPattern: ['day_of_month'],
					},
				},
			},
			{
				displayName: 'Which Week',
				name: 'scheduleNth',
				type: 'options',
				default: 1,
				options: [
					{ name: 'First', value: 1 },
					{ name: 'Second', value: 2 },
					{ name: 'Third', value: 3 },
					{ name: 'Fourth', value: 4 },
				],
				displayOptions: {
					show: {
						...taskAdvanced,
						cadence: ['recurring'],
						scheduleRepeat: ['monthly'],
						scheduleMonthlyPattern: ['nth_weekday'],
					},
				},
			},
			{
				displayName: 'Weekday',
				name: 'scheduleWeekday',
				type: 'options',
				default: 1,
				options: weekdayOptions,
				displayOptions: {
					show: {
						...taskAdvanced,
						cadence: ['recurring'],
						scheduleRepeat: ['monthly'],
						scheduleMonthlyPattern: ['nth_weekday', 'last_weekday'],
					},
				},
			},
			{
				displayName: 'Every Number of Days',
				name: 'scheduleInterval',
				type: 'number',
				default: 7,
				typeOptions: { minValue: 2, maxValue: 90 },
				displayOptions: {
					show: {
						...taskAdvanced,
						cadence: ['recurring'],
						scheduleRepeat: ['every_n_days'],
					},
				},
			},
			{
				displayName: 'Deadline After',
				name: 'deadlineAfterValue',
				type: 'number',
				default: 8,
				typeOptions: { minValue: 1 },
				description:
					'Time an employee has to complete each occurrence, counted from the moment it opens. Minutes cannot exceed 1439.',
				displayOptions: {
					show: { ...taskAdvanced, cadence: ['recurring'] },
				},
			},
			{
				displayName: 'Deadline After Unit',
				name: 'deadlineAfterUnit',
				type: 'options',
				default: 'hours',
				options: [
					{ name: 'Minutes', value: 'minutes' },
					{ name: 'Hours', value: 'hours' },
					{ name: 'Days', value: 'days' },
				],
				displayOptions: {
					show: { ...taskAdvanced, cadence: ['recurring'] },
				},
			},
			{
				displayName: 'Complete',
				name: 'audienceMode',
				type: 'options',
				default: 'individual',
				options: [
					{ name: 'Each Person Individually', value: 'individual' },
					{ name: 'Together as a Team', value: 'team' },
				],
				description:
					'Individually gives every employee their own task. As a team they share one task.',
				displayOptions: { show: taskAdvanced },
			},
			{
				displayName: 'Shared Task Per',
				name: 'instanceScope',
				type: 'options',
				default: 'organisation',
				options: [
					{ name: 'Whole Organisation', value: 'organisation' },
					{ name: 'Network', value: 'network' },
				],
				description:
					'One shared task for the organisation, or one per network in the audience',
				displayOptions: {
					show: { ...taskAdvanced, audienceMode: ['team'] },
				},
			},
			{
				displayName: 'Networks',
				name: 'audienceNetworkIds',
				type: 'multiOptions',
				typeOptions: { loadOptionsMethod: 'getNetworks' },
				default: [],
				description: 'Leave every audience field empty to target everyone',
				displayOptions: { show: taskAdvanced },
			},
			{
				displayName: 'Functions',
				name: 'audienceFunctionIds',
				type: 'multiOptions',
				typeOptions: { loadOptionsMethod: 'getFunctions' },
				default: [],
				displayOptions: { show: taskAdvanced },
			},
			{
				displayName: 'Employees',
				name: 'audienceUsers',
				type: 'fixedCollection',
				placeholder: 'Add Employee',
				typeOptions: { multipleValues: true },
				default: {},
				description:
					'Leave every audience field empty to target everyone. Needs the users.view scope. Search loads one page at a time.',
				displayOptions: { show: taskAdvanced },
				options: [
					{
						displayName: 'Employee',
						name: 'user',
						values: [
							searchLocator('Employee', 'id', 'searchUsers'),
						],
					},
				],
			},
			{
				displayName: 'Match',
				name: 'audiencePredicateType',
				type: 'options',
				default: 'match_all',
				options: [
					{ name: 'All Conditions', value: 'match_all' },
					{ name: 'Any Condition', value: 'match_any' },
				],
				description:
					'All conditions means an employee must match every filled audience field',
				displayOptions: { show: taskAdvanced },
			},
			{
				displayName: 'Icon',
				name: 'taskIcon',
				type: 'options',
				default: 'default/forms/account-circle.png',
				options: taskIconOptions,
				displayOptions: { show: taskAdvanced },
			},
			{
				displayName: 'Color',
				name: 'taskColor',
				type: 'color',
				default: '#007AFF',
				displayOptions: { show: taskAdvanced },
			},
			{
				displayName: 'Description',
				name: 'taskDescription',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				displayOptions: { show: taskAdvanced },
			},
			{
				displayName: 'Questions',
				name: 'taskQuestions',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Question',
				description:
					'Same question types as in the Oneteam admin. Leave empty for a mark-as-done task.',
				displayOptions: { show: taskAdvanced },
				options: [
					{
						name: 'question',
						displayName: 'Question',
						values: [
							{
								displayName: 'Type',
								name: 'type',
								type: 'options',
								default: 'question_text',
								options: [
									{ name: 'Text', value: 'question_text' },
									{ name: 'Number', value: 'question_number' },
									{ name: 'Yes / No', value: 'question_boolean' },
									{ name: 'Checklist', value: 'question_checklist' },
									{ name: 'Dropdown', value: 'question_dropdown' },
									{ name: 'Date and Time', value: 'question_datetime' },
									{ name: 'Slider', value: 'question_slider' },
									{ name: 'File Upload', value: 'question_file_upload' },
								],
							},
							{
								displayName: 'Question',
								name: 'text',
								type: 'string',
								required: true,
								default: '',
							},
							{
								displayName: 'Required',
								name: 'answerRequired',
								type: 'boolean',
								default: false,
							},
							{
								displayName: 'Options',
								name: 'optionList',
								type: 'fixedCollection',
								typeOptions: { multipleValues: true, sortable: true },
								default: {},
								placeholder: 'Add Option',
								description:
									'Add as many answer options as you need. Pasting several lines into one option splits them.',
								displayOptions: {
									show: {
										type: ['question_checklist', 'question_dropdown'],
									},
								},
								options: [
									{
										name: 'option',
										displayName: 'Option',
										values: [
											{
												displayName: 'Option',
												name: 'value',
												type: 'string',
												default: '',
											},
										],
									},
								],
							},
							{
								displayName: 'Yes Label',
								name: 'labelTrue',
								type: 'string',
								default: 'Yes',
								displayOptions: { show: { type: ['question_boolean'] } },
							},
							{
								displayName: 'No Label',
								name: 'labelFalse',
								type: 'string',
								default: 'No',
								displayOptions: { show: { type: ['question_boolean'] } },
							},
							{
								displayName: 'Steps',
								name: 'amountOfSteps',
								type: 'number',
								default: 5,
								typeOptions: { minValue: 2, maxValue: 10 },
								displayOptions: { show: { type: ['question_slider'] } },
							},
							{
								displayName: 'Left Label',
								name: 'labelLeft',
								type: 'string',
								default: '',
								displayOptions: { show: { type: ['question_slider'] } },
							},
							{
								displayName: 'Center Label',
								name: 'labelCenter',
								type: 'string',
								default: '',
								displayOptions: { show: { type: ['question_slider'] } },
							},
							{
								displayName: 'Right Label',
								name: 'labelRight',
								type: 'string',
								default: '',
								displayOptions: { show: { type: ['question_slider'] } },
							},
							{
								displayName: 'Allow Date',
								name: 'allowDateSelect',
								type: 'boolean',
								default: true,
								displayOptions: { show: { type: ['question_datetime'] } },
							},
							{
								displayName: 'Allow Time',
								name: 'allowTimeSelect',
								type: 'boolean',
								default: true,
								displayOptions: { show: { type: ['question_datetime'] } },
							},
							{
								displayName: 'Allow Multiple Files',
								name: 'allowMultipleUploads',
								type: 'boolean',
								default: false,
								displayOptions: {
									show: { type: ['question_file_upload'] },
								},
							},
						],
					},
				],
			},
			{
				displayName: 'Publish',
				name: 'publishTask',
				type: 'boolean',
				default: true,
				description:
					'Publish the task so Oneteam starts assigning it. Turn this off to keep it as a draft.',
				displayOptions: { show: taskAdvanced },
			},
			{
				displayName: 'Add To Do and Completed Statuses',
				name: 'addDefaultResponseStatuses',
				type: 'boolean',
				default: true,
				description:
					'Add the To do and Completed response statuses and show them to employees',
				displayOptions: { show: taskAdvanced },
			},
			{
				displayName: 'Send To',
				name: 'recipientType',
				type: 'options',
				default: 'userId',
				options: [
					{ name: 'User ID', value: 'userId' },
					{ name: 'External ID', value: 'externalId' },
					{ name: 'Email', value: 'email' },
				],
				displayOptions: { show: directMessage },
			},
			{
				displayName: 'User ID',
				name: 'recipientUserId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: { ...directMessage, recipientType: ['userId'] },
				},
			},
			{
				displayName: 'External ID',
				name: 'recipientExternalId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: { ...directMessage, recipientType: ['externalId'] },
				},
			},
			{
				displayName: 'Email',
				name: 'recipientEmail',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: { ...directMessage, recipientType: ['email'] },
				},
			},
			searchLocator('Form or Task', 'statusFormId', 'searchStatusTargets', {
				description: 'Search by title (3+ characters), or paste an ID',
				displayOptions: { show: statusUpdate },
			}),
			searchLocator('Submission', 'statusSubmissionId', 'searchSubmissions', {
				description:
					'People in the audience of the selected task, or submissions of the selected form. Needs the forms.view-report scope.',
				displayOptions: { show: statusUpdate },
			}),
			{
				displayName: 'Response Status',
				name: 'responseStatusId',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getResponseStatuses',
					loadOptionsDependsOn: ['statusFormId'],
				},
				required: true,
				default: '',
				description: 'Statuses on the selected form or task',
				displayOptions: { show: statusUpdate },
			},
		],
	};

	methods = {
		listSearch: {
			...formAndCourseSearch,
			async searchSurveys(
				this: ILoadOptionsFunctions,
				filter?: string,
				paginationToken?: string,
			): Promise<INodeListSearchResult> {
				return searchListedResource.call(this, {
					path: 'surveys',
					nameFields: ['title', 'name'],
					filter,
					paginationToken,
					minQueryLength: 3,
				});
			},
			async searchStatusTargets(
				this: ILoadOptionsFunctions,
				filter?: string,
				paginationToken?: string,
			): Promise<INodeListSearchResult> {
				const resource = this.getCurrentNodeParameter('resource') as string;
				return searchListedResource.call(this, {
					path: 'forms',
					nameFields: ['title', 'name'],
					filter,
					paginationToken,
					minQueryLength: 3,
					qs: resource === 'task' ? { type: 'task' } : {},
				});
			},
			async searchSubmissions(
				this: ILoadOptionsFunctions,
				filter?: string,
				paginationToken?: string,
			): Promise<INodeListSearchResult> {
				const formId = locatorId(
					this.getCurrentNodeParameter('statusFormId'),
				);
				if (!formId) return { results: [] };

				const organisation = await getOrganisation.call(this);
				const qs: IDataObject = {};
				const query = filter?.trim();
				if (query) qs.q = query;

				const page = await listPage.call(
					this,
					organisationPath(organisation.id, `forms/${formId}/submissions`),
					qs,
					paginationToken,
				);

				return {
					results: submissionOptions(page.rows).map((row) => ({
						name: row.name,
						value: String(row.value),
					})),
					paginationToken: page.nextPage || undefined,
				};
			},
			async searchUsers(
				this: ILoadOptionsFunctions,
				filter?: string,
				paginationToken?: string,
			): Promise<INodeListSearchResult> {
				const organisation = await getOrganisation.call(this);
				const limit = 20;
				const offset = paginationToken ? Number(paginationToken) : 0;
				const qs: IDataObject = { limit, offset };
				const query = filter?.trim();
				if (query) qs.q = query;

				const response = await oneteamApiRequest.call(
					this,
					'GET',
					organisationPath(organisation.id, 'users', 'v2'),
					{},
					qs,
				);
				const page = (response.data as IDataObject[]) ?? [];

				return {
					results: page.map((row) => ({
						name: personName(row) || String(row.email || row.id),
						value: String(row.id),
					})),
					paginationToken:
						page.length < limit ? undefined : String(offset + limit),
				};
			},
		},
		loadOptions: {
			async getNetworks(
				this: ILoadOptionsFunctions,
			): Promise<INodePropertyOptions[]> {
				return listResourceOptions.call(this, 'networks', 'name');
			},
			async getFunctions(
				this: ILoadOptionsFunctions,
			): Promise<INodePropertyOptions[]> {
				return listResourceOptions.call(this, 'functions', 'name');
			},
			async getTeams(
				this: ILoadOptionsFunctions,
			): Promise<INodePropertyOptions[]> {
				return listResourceOptions.call(this, 'teams', 'name', 'v1');
			},
			async getResponseStatuses(
				this: ILoadOptionsFunctions,
			): Promise<INodePropertyOptions[]> {
				const formId = locatorId(
					this.getCurrentNodeParameter('statusFormId'),
				);

				if (!formId) return [];

				const organisation = await getOrganisation.call(this);
				const response = await oneteamApiRequest.call(
					this,
					'GET',
					organisationPath(organisation.id, `forms/${formId}`),
				);
				const form = apiRecord(response);
				const statuses = form.response_statuses;

				if (!Array.isArray(statuses)) return [];

				return statuses.map((status) => {
					const row = status as IDataObject;
					return {
						name: String(row.name ?? row.id),
						value: String(row.id),
					};
				});
			},
			async getLanguages(
				this: ILoadOptionsFunctions,
			): Promise<INodePropertyOptions[]> {
				const response = await oneteamApiRequest.call(
					this,
					'GET',
					'/v1/available-languages',
				);
				const rows = (response.data as Array<Record<string, string>>) ?? [];

				return rows.map((row) => ({
					name: row.name_eng ?? row.name ?? row.locale,
					value: row.locale,
				}));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;
		const organisation = await getOrganisation.call(this);
		// Task parameters are filled in on the node, so one execution creates
		// one task. Looping the input would repeat the same task for every row.
		const createsOneTask = resource === 'task' && operation === 'create';
		const itemCount = createsOneTask ? Math.min(items.length, 1) : items.length;

		for (let i = 0; i < itemCount; i++) {
			if (resource === 'employee' && operation === 'invite') {
				const body: IDataObject = {
					first_name: this.getNodeParameter('firstName', i),
					last_name: this.getNodeParameter('lastName', i),
					email: this.getNodeParameter('email', i),
				};
				const externalId = this.getNodeParameter('externalId', i) as string;
				const languageLocale = this.getNodeParameter(
					'languageLocale',
					i,
				) as string;

				if (externalId) body.external_id = externalId;
				if (languageLocale) body.language_locale = languageLocale;

				await pushRequest(
					this,
					returnData,
					'POST',
					organisationPath(organisation.id, 'users', 'v2'),
					body,
				);
				continue;
			}

			if (resource === 'employee' && operation === 'update') {
				const userId = this.getNodeParameter('userId', i) as string;
				const body: IDataObject = {};
				const fields: Array<[string, string]> = [
					['firstName', 'first_name'],
					['lastName', 'last_name'],
					['email', 'email'],
					['externalId', 'external_id'],
					['phoneNum', 'phone_num'],
					['dialCode', 'dial_code'],
				];

				for (const [parameter, apiKey] of fields) {
					const value = this.getNodeParameter(parameter, i) as string;
					if (value) body[apiKey] = value;
				}

				if (Object.keys(body).length === 0) {
					throw new NodeOperationError(
						this.getNode(),
						'Set at least one field to update',
						{ itemIndex: i },
					);
				}

				await pushRequest(
					this,
					returnData,
					'PUT',
					organisationPath(organisation.id, `users/${userId}`, 'v2'),
					body,
				);
				continue;
			}

			if (resource === 'feedMessage' && operation === 'create') {
				const body: IDataObject = {
					text: this.getNodeParameter('text', i),
				};
				const isImportant = this.getNodeParameter('isImportant', i) as boolean;
				const publishAt = this.getNodeParameter('publishAt', i) as string;

				if (isImportant) body.is_important = true;
				if (publishAt) body.publish_at = publishAt;

				await pushRequest(
					this,
					returnData,
					'POST',
					organisationPath(organisation.id, 'organisation_messages'),
					body,
				);
				continue;
			}

			if (resource === 'membership' && operation === 'update') {
				const userId = this.getNodeParameter('userId', i) as string;
				const kind = this.getNodeParameter('kind', i) as
					| 'networks'
					| 'functions'
					| 'teams';
				const action =
					(this.getNodeParameter('action', i) as string) === 'remove'
						? 'remove'
						: 'add';
				const idParameter =
					kind === 'networks'
						? 'networkId'
						: kind === 'functions'
							? 'functionId'
							: 'teamId';
				const targetId = String(this.getNodeParameter(idParameter, i));

				const response = await oneteamApiRequest.call(
					this,
					'PUT',
					organisationPath(organisation.id, `users/${userId}/${kind}`, 'v2'),
					action === 'remove'
						? { add: [], remove: [targetId] }
						: { add: [targetId], remove: [] },
				);

				returnData.push({
					json: {
						id: `${userId}:${targetId}:${action}`,
						success: (response.success as boolean) ?? true,
						user_id: userId,
						kind,
						target_id: targetId,
						action,
					},
				});
				continue;
			}

			if (
				(resource === 'form' || resource === 'task') &&
				operation === 'list'
			) {
				await pushListedRows(
					this,
					returnData,
					i,
					organisationPath(organisation.id, 'forms'),
					resource === 'task' ? { type: 'task' } : {},
				);
				continue;
			}

			if (resource === 'form' && operation === 'listSubmissions') {
				const formId = parameterId(this, 'formId', i);
				await pushListedRows(
					this,
					returnData,
					i,
					organisationPath(organisation.id, `forms/${formId}/submissions`),
				);
				continue;
			}

			if (resource === 'form' && operation === 'getSubmission') {
				const formId = parameterId(this, 'formId', i);
				const submissionId = this.getNodeParameter('submissionId', i) as string;
				await pushRequest(
					this,
					returnData,
					'GET',
					organisationPath(
						organisation.id,
						`forms/${formId}/submissions/${submissionId}`,
					),
				);
				continue;
			}

			if (
				(resource === 'form' && operation === 'updateSubmissionStatus') ||
				(resource === 'task' && operation === 'updateStatus')
			) {
				const formId = parameterId(this, 'statusFormId', i);
				const submissionId = parameterId(this, 'statusSubmissionId', i);
				const collection = resource === 'task' ? 'tasks' : 'forms';
				const version = resource === 'task' ? 'v2' : 'v1';
				await pushRequest(
					this,
					returnData,
					'PATCH',
					organisationPath(
						organisation.id,
						`${collection}/${formId}/submissions/${submissionId}/response_status`,
						version,
					),
					{ id: this.getNodeParameter('responseStatusId', i) },
				);
				continue;
			}

			if (resource === 'task' && operation === 'create') {
				const description = (
					this.getNodeParameter('taskDescription', i) as string
				).trim();
				const audience = taskAudienceBody(this, i);
				const withStatuses = this.getNodeParameter(
					'addDefaultResponseStatuses',
					i,
				) as boolean;
				const settings: IDataObject = { task: taskSettingsBody(this, i) };
				// Validate the questions before creating anything, so a bad
				// question never leaves an empty task behind in Oneteam
				const questions = taskQuestionBodies(this, i);

				if (withStatuses) {
					settings.show_status_to_users = true;
					settings.notify_user_of_status_updates = true;
				}

				// A task is always created as a draft; status is set by publishing
				const created = await oneteamApiRequest.call(
					this,
					'POST',
					organisationPath(organisation.id, 'forms'),
					{
						title: this.getNodeParameter('title', i),
						...(description ? { description } : {}),
						icon: this.getNodeParameter('taskIcon', i),
						color: this.getNodeParameter('taskColor', i),
						form_type: 'task',
						settings,
						...(audience ? { audience } : {}),
						...(withStatuses
							? {
									response_statuses: [
										{ name: 'To do', color: '#888888' },
										{ name: 'Completed', color: '#22c55e' },
									],
								}
							: {}),
					},
				);
				const task = apiRecord(created);

				try {
					for (const question of questions) {
						await oneteamApiRequest.call(
							this,
							'POST',
							organisationPath(organisation.id, `forms/${task.id}/screens`),
							question,
						);
					}

					if (!this.getNodeParameter('publishTask', i)) {
						returnData.push({ json: task });
						continue;
					}

					const published = await oneteamApiRequest.call(
						this,
						'PUT',
						organisationPath(organisation.id, `forms/${task.id}`),
						{ status: 'live' },
					);
					pushApiRecord(returnData, published);
				} catch (error) {
					await deleteDraftTask(this, organisation.id, String(task.id));
					throw error;
				}

				continue;
			}

			if (resource === 'notification' && operation === 'send') {
				await pushRequest(
					this,
					returnData,
					'POST',
					organisationPath(organisation.id, 'notifications', 'v2'),
					{
						heading: this.getNodeParameter('heading', i),
						text: this.getNodeParameter('text', i),
						...directRecipientBody(this, i),
					},
				);
				continue;
			}

			if (resource === 'chatMessage' && operation === 'send') {
				const attachmentId = (
					this.getNodeParameter('attachmentId', i) as string
				).trim();
				await pushRequest(
					this,
					returnData,
					'POST',
					organisationPath(organisation.id, 'chat/messages', 'v2'),
					{
						text: this.getNodeParameter('text', i),
						...(attachmentId ? { attachment_id: attachmentId } : {}),
						...directRecipientBody(this, i),
					},
				);
				continue;
			}

			if (resource === 'course' && operation === 'list') {
				await pushListedRows(
					this,
					returnData,
					i,
					organisationPath(organisation.id, 'courses', 'v2'),
				);
				continue;
			}

			if (
				resource === 'course' &&
				(operation === 'statistics' ||
					operation === 'userProgress' ||
					operation === 'feedback')
			) {
				const courseId = parameterId(this, 'courseId', i);
				const coursePath =
					operation === 'feedback'
						? organisationPath(organisation.id, `courses/${courseId}/feedback`)
						: organisationPath(
								organisation.id,
								operation === 'statistics'
									? `courses/${courseId}/statistics`
									: `courses/${courseId}/statistics/userprogress`,
								'v2',
							);

				if (operation === 'statistics') {
					await pushRequest(this, returnData, 'GET', coursePath);
				} else {
					await pushListedRows(this, returnData, i, coursePath);
				}
				continue;
			}

			if (resource === 'survey' && operation === 'list') {
				await pushListedRows(
					this,
					returnData,
					i,
					organisationPath(organisation.id, 'surveys'),
				);
				continue;
			}

			if (resource === 'survey' && operation === 'report') {
				const surveyId = parameterId(this, 'surveyId', i);
				await pushRequest(
					this,
					returnData,
					'GET',
					organisationPath(organisation.id, `surveys/${surveyId}/report`),
				);
				continue;
			}

			if (resource === 'performance' && operation === 'summary') {
				await pushRequest(
					this,
					returnData,
					'GET',
					organisationPath(organisation.id, 'performance/reports/summary'),
				);
				continue;
			}

			if (resource === 'onboarding' && operation === 'statistics') {
				await pushRequest(
					this,
					returnData,
					'GET',
					organisationPath(organisation.id, 'onboarding/statistics', 'v2'),
				);
				continue;
			}

			if (resource === 'onboarding' && operation === 'userProgress') {
				await pushListedRows(
					this,
					returnData,
					i,
					organisationPath(
						organisation.id,
						'onboarding/statistics/userprogress',
						'v2',
					),
				);
				continue;
			}

			if (resource === 'analytics' && operation === 'catalog') {
				const response = await oneteamApiRequest.call(
					this,
					'GET',
					organisationPath(organisation.id, 'metrics/catalog'),
				);
				const catalog = (response.data as IDataObject) ?? {};
				const metrics = Array.isArray(catalog.metrics) ? catalog.metrics : [];
				for (const metric of metrics) {
					returnData.push({ json: metric as IDataObject });
				}
				continue;
			}

			if (resource === 'analytics' && (operation === 'reports' || operation === 'run')) {
				const range = reportDateRange(this, i);
				if (operation === 'reports') {
					const response = await oneteamApiRequest.call(
						this,
						'GET',
						organisationPath(organisation.id, 'metrics/reports'),
						{},
						{ include_results: true, ...range.query },
					);
					pushAnalyticsRows(returnData, response);
					continue;
				}

				const chartType = this.getNodeParameter('chartType', i) as string;
				const metricKey = this.getNodeParameter('metricKey', i) as string;
				const body: IDataObject = {
					chart_type: chartType,
					y_axis: { kind: 'metric', metric_key: metricKey },
					date_range: range.body,
				};
				if (chartType !== 'kpi' && chartType !== 'gauge') {
					body.x_axis = { kind: 'date', granularity: 'day' };
				}
				await pushRequest(
					this,
					returnData,
					'POST',
					organisationPath(organisation.id, 'metrics/reports/run'),
					body,
				);
				continue;
			}

			if (resource === 'analytics') {
				const qs: IDataObject = {};
				if (operation !== 'networks') {
					qs.metrics = this.getNodeParameter('metrics', i) as string[];
				}
				const pathByOperation: Record<string, string> = {
					get: organisationPath(organisation.id, 'analytics'),
					counts: organisationPath(organisation.id, 'analytics/counts'),
					users: organisationPath(organisation.id, 'analytics/users'),
					networks: organisationPath(organisation.id, 'analytics/networks'),
				};

				if (operation !== 'counts') {
					const fromDate = this.getNodeParameter('fromDate', i) as string;
					const toDate = this.getNodeParameter('toDate', i) as string;
					if (fromDate) qs.from_date = fromDate.slice(0, 10);
					if (toDate) qs.to_date = toDate.slice(0, 10);
				}

				if (operation === 'users') {
					await pushAnalyticsUsers(
						this,
						returnData,
						i,
						pathByOperation[operation],
						qs,
					);
					continue;
				}

				const response = await oneteamApiRequest.call(
					this,
					'GET',
					pathByOperation[operation],
					{},
					qs,
				);
				pushAnalyticsRows(returnData, response);
			}
		}

		return [returnData];
	}
}
