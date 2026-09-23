import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	getOrganisation,
	listAllPages,
	listPage,
	listResourceOptions,
	oneteamApiRequest,
} from './GenericFunctions';

const pagedLists = {
	resource: ['form', 'course', 'onboarding', 'survey'],
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
					{ name: 'Course', value: 'course' },
					{ name: 'Onboarding', value: 'onboarding' },
					{ name: 'Analytics', value: 'analytics' },
					{ name: 'Survey', value: 'survey' },
					{ name: 'Performance', value: 'performance' },
				],
				default: 'employee',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['employee'] } },
				options: [
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
				default: 'invite',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['feedMessage'] } },
				options: [
					{
						name: 'Create',
						value: 'create',
						action: 'Create an organization message',
						description: 'Create an organization message',
					},
				],
				default: 'create',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['membership'] } },
				options: [
					{
						name: 'Add or Remove',
						value: 'update',
						action: 'Add or remove an employee membership',
						description:
							'Add or remove an employee from a network, function or team',
					},
				],
				default: 'update',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['form'] } },
				options: [
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
				],
				default: 'list',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['course'] } },
				options: [
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
				default: 'list',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['onboarding'] } },
				options: [
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
				default: 'statistics',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['survey'] } },
				options: [
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
				default: 'list',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['performance'] } },
				options: [
					{
						name: 'Get Summary',
						value: 'summary',
						action: 'Get the performance summary',
						description: 'Get the performance review summary',
					},
				],
				default: 'summary',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['analytics'] } },
				options: [
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
				default: 'get',
			},
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
			{
				displayName: 'Course ID',
				name: 'courseId',
				type: 'string',
				required: true,
				default: '',
				description: 'Course ID from List courses',
				displayOptions: {
					show: {
						resource: ['course'],
						operation: ['statistics', 'userProgress', 'feedback'],
					},
				},
			},
			{
				displayName: 'Survey ID',
				name: 'surveyId',
				type: 'string',
				required: true,
				default: '',
				description: 'Survey ID from List surveys',
				displayOptions: {
					show: { resource: ['survey'], operation: ['report'] },
				},
			},
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
			{
				displayName: 'Form Name or ID',
				name: 'formId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getForms' },
				required: true,
				default: '',
				description:
					'Choose from the list, or specify an ID using an expression.',
				displayOptions: {
					show: {
						resource: ['form'],
						operation: ['listSubmissions', 'getSubmission'],
					},
				},
			},
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
		],
	};

	methods = {
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
			async getForms(
				this: ILoadOptionsFunctions,
			): Promise<INodePropertyOptions[]> {
				return listResourceOptions.call(this, 'forms', 'title', 'v1');
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

		for (let i = 0; i < items.length; i++) {
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

				const response = await oneteamApiRequest.call(
					this,
					'POST',
					`/v2/organisations/${organisation.id}/users`,
					body,
				);

				returnData.push({ json: (response.data as IDataObject) ?? response });
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

				const response = await oneteamApiRequest.call(
					this,
					'PUT',
					`/v2/organisations/${organisation.id}/users/${userId}`,
					body,
				);

				returnData.push({ json: (response.data as IDataObject) ?? response });
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

				const response = await oneteamApiRequest.call(
					this,
					'POST',
					`/v1/organisations/${organisation.id}/organisation_messages`,
					body,
				);

				returnData.push({ json: (response.data as IDataObject) ?? response });
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
					`/v2/organisations/${organisation.id}/users/${userId}/${kind}`,
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

			if (resource === 'form' && operation === 'list') {
				await pushListedRows(
					this,
					returnData,
					i,
					`/v1/organisations/${organisation.id}/forms`,
				);
				continue;
			}

			if (resource === 'form' && operation === 'listSubmissions') {
				const formId = this.getNodeParameter('formId', i) as string;
				await pushListedRows(
					this,
					returnData,
					i,
					`/v1/organisations/${organisation.id}/forms/${formId}/submissions`,
				);
				continue;
			}

			if (resource === 'form' && operation === 'getSubmission') {
				const formId = this.getNodeParameter('formId', i) as string;
				const submissionId = this.getNodeParameter('submissionId', i) as string;
				const response = await oneteamApiRequest.call(
					this,
					'GET',
					`/v1/organisations/${organisation.id}/forms/${formId}/submissions/${submissionId}`,
				);
				returnData.push({ json: (response.data as IDataObject) ?? response });
				continue;
			}

			if (resource === 'course' && operation === 'list') {
				await pushListedRows(
					this,
					returnData,
					i,
					`/v2/organisations/${organisation.id}/courses`,
				);
				continue;
			}

			if (resource === 'course' && operation === 'statistics') {
				const courseId = this.getNodeParameter('courseId', i) as string;
				const response = await oneteamApiRequest.call(
					this,
					'GET',
					`/v2/organisations/${organisation.id}/courses/${courseId}/statistics`,
				);
				returnData.push({ json: (response.data as IDataObject) ?? response });
				continue;
			}

			if (resource === 'course' && operation === 'userProgress') {
				const courseId = this.getNodeParameter('courseId', i) as string;
				await pushListedRows(
					this,
					returnData,
					i,
					`/v2/organisations/${organisation.id}/courses/${courseId}/statistics/userprogress`,
				);
				continue;
			}

			if (resource === 'course' && operation === 'feedback') {
				const courseId = this.getNodeParameter('courseId', i) as string;
				await pushListedRows(
					this,
					returnData,
					i,
					`/v1/organisations/${organisation.id}/courses/${courseId}/feedback`,
				);
				continue;
			}

			if (resource === 'survey' && operation === 'list') {
				await pushListedRows(
					this,
					returnData,
					i,
					`/v1/organisations/${organisation.id}/surveys`,
				);
				continue;
			}

			if (resource === 'survey' && operation === 'report') {
				const surveyId = this.getNodeParameter('surveyId', i) as string;
				const response = await oneteamApiRequest.call(
					this,
					'GET',
					`/v1/organisations/${organisation.id}/surveys/${surveyId}/report`,
				);
				returnData.push({ json: (response.data as IDataObject) ?? response });
				continue;
			}

			if (resource === 'performance' && operation === 'summary') {
				const response = await oneteamApiRequest.call(
					this,
					'GET',
					`/v1/organisations/${organisation.id}/performance/reports/summary`,
				);
				returnData.push({ json: (response.data as IDataObject) ?? response });
				continue;
			}

			if (resource === 'onboarding' && operation === 'statistics') {
				const response = await oneteamApiRequest.call(
					this,
					'GET',
					`/v2/organisations/${organisation.id}/onboarding/statistics`,
				);
				returnData.push({ json: (response.data as IDataObject) ?? response });
				continue;
			}

			if (resource === 'onboarding' && operation === 'userProgress') {
				await pushListedRows(
					this,
					returnData,
					i,
					`/v2/organisations/${organisation.id}/onboarding/statistics/userprogress`,
				);
				continue;
			}

			if (resource === 'analytics' && operation === 'catalog') {
				const response = await oneteamApiRequest.call(
					this,
					'GET',
					`/v1/organisations/${organisation.id}/metrics/catalog`,
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
						`/v1/organisations/${organisation.id}/metrics/reports`,
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
				const response = await oneteamApiRequest.call(
					this,
					'POST',
					`/v1/organisations/${organisation.id}/metrics/reports/run`,
					body,
				);
				returnData.push({ json: (response.data as IDataObject) ?? response });
				continue;
			}

			if (resource === 'analytics') {
				const qs: IDataObject = {};
				if (operation !== 'networks') {
					qs.metrics = this.getNodeParameter('metrics', i) as string[];
				}
				const pathByOperation: Record<string, string> = {
					get: `/v1/organisations/${organisation.id}/analytics`,
					counts: `/v1/organisations/${organisation.id}/analytics/counts`,
					users: `/v1/organisations/${organisation.id}/analytics/users`,
					networks: `/v1/organisations/${organisation.id}/analytics/networks`,
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
