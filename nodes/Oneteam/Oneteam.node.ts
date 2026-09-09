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
	listResourceOptions,
	oneteamApiRequest,
} from './GenericFunctions';

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
					{ name: 'Feed Message', value: 'feedMessage' },
					{ name: 'Membership', value: 'membership' },
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
						action: 'Create a feed message',
						description: 'Create a message on the organisation feed',
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
			}
		}

		return [returnData];
	}
}
