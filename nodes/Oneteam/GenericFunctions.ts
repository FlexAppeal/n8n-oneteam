import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

type OneteamContext =
	| IExecuteFunctions
	| ILoadOptionsFunctions
	| IHookFunctions
	| IWebhookFunctions;

export type Organisation = {
	id: string;
	name: string;
};

export async function oneteamApiRequest(
	this: OneteamContext,
	method: IHttpRequestMethods,
	path: string,
	body: IDataObject = {},
	qs: IDataObject = {},
): Promise<IDataObject> {
	const credentials = await this.getCredentials('oneteamApi');
	const baseUrl = String(credentials.baseUrl ?? '').replace(/\/$/, '');

	try {
		return (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'oneteamApi',
			{
				method,
				url: `${baseUrl}${path}`,
				body: Object.keys(body).length ? body : undefined,
				qs: Object.keys(qs).length ? qs : undefined,
				json: true,
			},
		)) as IDataObject;
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
}

export async function getOrganisation(
	this: OneteamContext,
): Promise<Organisation> {
	const response = await oneteamApiRequest.call(
		this,
		'GET',
		'/v1/organisations',
	);
	const organisations = (response.data as Organisation[]) ?? [];

	if (organisations.length === 0) {
		throw new NodeOperationError(
			this.getNode(),
			'This token has no organisation. Create a service account token in Oneteam under Organisation Settings.',
		);
	}

	if (organisations.length > 1) {
		throw new NodeOperationError(
			this.getNode(),
			'This token can access multiple organisations. Use an organisation service account token instead of a personal token.',
		);
	}

	return organisations[0];
}

export async function listResourceOptions(
	this: ILoadOptionsFunctions,
	path: string,
	nameField: 'name' | 'title',
	apiVersion: 'v1' | 'v2' = 'v2',
): Promise<Array<{ name: string; value: string }>> {
	const organisation = await getOrganisation.call(this);
	const response = await oneteamApiRequest.call(
		this,
		'GET',
		`/${apiVersion}/organisations/${organisation.id}/${path}`,
	);
	const rows = (response.data as IDataObject[]) ?? [];

	return rows.map((row) => ({
		name: String(row[nameField] ?? row.id),
		value: String(row.id),
	}));
}
