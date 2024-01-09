import { AsyncQueue, messages, PreparedObjectType } from '@pgtyped/wire';
import crypto from 'crypto';
import debugBase from 'debug';
import * as tls from 'tls';
import type { InterpolatedQuery, QueryParameter } from '@pgtyped/runtime';
import {
  checkServerFinalMessage,
  createClientSASLContinueResponse,
  createInitialSASLResponse,
} from './sasl-helpers.js';
import { DatabaseTypeKind, isEnum, MappableType } from './type.js';

const debugQuery = debugBase('client:query');

export const generateHash = (
  username: string,
  password: string,
  salt: Buffer,
) => {
  const hash = (str: string) =>
    crypto.createHash('md5').update(str).digest('hex');
  const shadow = hash(password + username);
  const result = crypto.createHash('md5');
  result.update(shadow);
  result.update(salt);
  return 'md5' + result.digest('hex');
};

export async function startup(
  options: {
    host: string;
    password?: string;
    port: number;
    user: string;
    dbName: string;
    ssl?: tls.ConnectionOptions | boolean;
  },
  queue: AsyncQueue,
) {
  try {
    await queue.connect(options);
    const startupParams = {
      user: options.user,
      database: options.dbName,
      client_encoding: "'utf-8'",
      application_name: 'pgtyped',
    };
    await queue.send(messages.startupMessage, { params: startupParams });
    const result = await queue.reply(
      messages.readyForQuery,
      messages.authenticationCleartextPassword,
      messages.authenticationMD5Password,
      messages.authenticationSASL,
    );
    if ('trxStatus' in result) {
      // No auth required
      return;
    }
    if (!options.password) {
      throw new Error('password required for hash auth');
    }
    let password = options.password;
    if ('SASLMechanisms' in result) {
      if (result.SASLMechanisms?.indexOf('SCRAM-SHA-256') === -1) {
        throw new Error(
          'SASL: Only mechanism SCRAM-SHA-256 is currently supported',
        );
      }

      const { clientNonce, response: initialSASLResponse } =
        createInitialSASLResponse();
      await queue.send(messages.SASLInitialResponse, {
        mechanism: 'SCRAM-SHA-256',
        responseLength: Buffer.byteLength(initialSASLResponse),
        response: initialSASLResponse,
      });

      const SASLContinueResult = await queue.reply(
        messages.AuthenticationSASLContinue,
      );

      const { response: SASLContinueResponse, calculatedServerSignature } =
        createClientSASLContinueResponse(
          password,
          clientNonce,
          SASLContinueResult.SASLData,
        );

      await queue.send(messages.SASLResponse, {
        response: SASLContinueResponse,
      });

      const finalSASL = await queue.reply(messages.authenticationSASLFinal);
      await queue.reply(messages.authenticationOk);
      while (true) {
        const res = await queue.reply(
          messages.parameterStatus,
          messages.backendKeyData,
          messages.readyForQuery,
        );
        // break when we get readyForQuery
        if ('trxStatus' in res) {
          break;
        }
      }

      if ('SASLData' in finalSASL) {
        checkServerFinalMessage(finalSASL.SASLData, calculatedServerSignature);
        return;
      } else {
        throw new Error('SASL: No final SASL data returned');
      }
    }
    if ('salt' in result) {
      // hash password for md5 auth
      password = generateHash(options.user, password, result.salt);
    }
    // handles both cleartext and md5 password auth
    await queue.send(messages.passwordMessage, { password });
    await queue.reply(messages.authenticationOk);
    await queue.reply(messages.readyForQuery);
  } catch (e) {
    // tslint:disable-next-line:no-console
    console.error(`Connection failed: ${(e as any).message}`);
    process.exit(1);
  }
}

export async function runQuery(query: string, queue: AsyncQueue) {
  const resultRows = [];
  await queue.send(messages.query, { query });
  debugQuery('sent query %o', query);
  {
    const result = await queue.reply(messages.rowDescription);
    debugQuery(
      'received row description: %o',
      result.fields.map((c) => c.name.toString()),
    );
  }
  {
    while (true) {
      const result = await queue.reply(
        messages.dataRow,
        messages.commandComplete,
      );
      if ('commandTag' in result) {
        break;
      }
      const row = result.columns.map((c) => c.value.toString());
      resultRows.push(row);
      debugQuery('received row data: %o', row);
    }
  }
  return resultRows;
}

export interface IQueryTypes {
  paramMetadata: {
    mapping: QueryParameter[];
    params: MappableType[];
  };
  returnTypes: Array<{
    returnName: string;
    columnName: string;
    type: MappableType;
    nullable?: boolean;
    comment?: string;
  }>;
}

export interface IParseError {
  errorCode: string;
  hint?: string;
  message: string;
  position?: string;
}

interface TypeField {
  name: string;
  tableOID: number;
  columnAttrNumber: number;
  typeOID: number;
  typeSize: number;
  typeModifier: number;
  formatCode: number;
}

type TypeData =
  | {
      fields: Array<TypeField>;
      params: Array<{ oid: number }>;
    }
  | IParseError;

// Copied from https://github.com/brianc/node-postgres/blob/860cccd53105f7bc32fed8b1de69805f0ecd12eb/lib/client.js#L285-L302
// Ported from PostgreSQL 9.2.4 source code in src/interfaces/libpq/fe-exec.c
// Replaced with regexp because it's 11x faster by Benjie.
// Added `\0` escape because PostgreSQL strings cannot contain `\0` but JS strings can.
export function escapeSqlIdentifier(str: string): string {
  return `"${str.replace(/["\0]/g, '""')}"`;
}

/**
 * Returns the raw query type data as returned by the Describe message
 * @param query query string, can only contain proper Postgres numeric placeholders
 * @param queue
 */
export async function getTypeData(
  query: string,
  queue: AsyncQueue,
): Promise<TypeData> {
  const uniqueName = crypto.createHash('md5').update(query).digest('hex');
  // Send all the messages needed and then flush
  await queue.send(messages.parse, {
    name: uniqueName,
    query,
    dataTypes: [],
  });
  await queue.send(messages.describe, {
    name: uniqueName,
    type: PreparedObjectType.Statement,
  });
  await queue.send(messages.close, {
    target: PreparedObjectType.Statement,
    targetName: uniqueName,
  });
  await queue.send(messages.flush, {});

  const parseResult = await queue.reply(
    messages.errorResponse,
    messages.parseComplete,
  );

  // Recover server state from any errors
  await queue.send(messages.sync, {});

  if ('fields' in parseResult) {
    // Error case
    const { fields: errorFields } = parseResult;
    return {
      errorCode: errorFields.R,
      hint: errorFields.H,
      message: errorFields.M,
      position: errorFields.P,
    };
  }
  const paramsResult = await queue.reply(
    messages.parameterDescription,
    messages.noData,
  );
  const params = 'params' in paramsResult ? paramsResult.params : [];
  const fieldsResult = await queue.reply(
    messages.rowDescription,
    messages.noData,
  );
  const fields = 'fields' in fieldsResult ? fieldsResult.fields : [];
  await queue.reply(messages.closeComplete);
  return { params, fields };
}

/**
 * Checks that `EXPLAIN EXECUTE` of the prepared statement works, otherwise returns the error.
 * @param query query string, can only contain proper Postgres numeric placeholders
 * @param typeData type data, the result from getTypeData for this same query
 * @param queue
 */
export async function explainQuery(
  query: string,
  typeData: TypeData,
  queue: AsyncQueue,
): Promise<string[] | IParseError> {
  if ('errorCode' in typeData) return typeData;
  const uniqueName = crypto.createHash('md5').update(query).digest('hex');
  // Prepare query
  await queue.send(messages.parse, {
    name: uniqueName,
    query,
    dataTypes: [],
  });
  await queue.send(messages.flush, {});
  const parseResult = await queue.reply(
    messages.errorResponse,
    messages.parseComplete,
  );
  try {
    if ('fields' in parseResult) {
      // Error case
      const { fields: errorFields } = parseResult;
      return {
        errorCode: errorFields.R,
        hint: errorFields.H,
        message: errorFields.M,
        position: errorFields.P,
      };
    }

    // Explain query (will throw error on permissions failure). Leverages the
    // fact that nullability is not checked in types at this stage, so `null` is
    // a valid value for all types (yes, even domain types with a `non null`
    // constraint).
    const length = typeData.params.length;
    const params = Array.from({ length }, () => 'null');
    const explain = await runQuery(
      `explain execute ${escapeSqlIdentifier(uniqueName)}${
        params.length === 0 ? '' : ` (${params.join(', ')})`
      };`,
      queue,
    );

    return explain.map((e) => e[0]);
  } catch (e: any) {
    // This is most likely from the `runQuery` statement
    /* Example error:
     * ```
     * {
     *   type: 'ServerError',
     *   bufferOffset: 100,
     *   severity: 'ERROR',
     *   message: 'permission denied for table user_emails'
     * }
     * ```
     */
    console.error('Error occurred whilst testing query:', e);
    return {
      errorCode: '_ERROR',
      message: e.message,
    };
  } finally {
    // Release prepared statement
    await queue.send(messages.close, {
      target: PreparedObjectType.Statement,
      targetName: uniqueName,
    });

    // Flush all messages
    await queue.send(messages.flush, {});

    // Recover server state from any errors
    await queue.send(messages.sync, {});
    await queue.reply(messages.closeComplete);
  }
}

enum TypeCategory {
  ARRAY = 'A',
  BOOLEAN = 'B',
  COMPOSITE = 'C',
  DATE_TIME = 'D',
  ENUM = 'E',
  GEOMETRIC = 'G',
  NETWORK_ADDRESS = 'I',
  NUMERIC = 'N',
  PSEUDO = 'P',
  STRING = 'S',
  TIMESPAN = 'T',
  USERDEFINED = 'U',
  BITSTRING = 'V',
  UNKNOWN = 'X',
}

interface TypeRow {
  oid: string;
  typeName: string;
  typeKind: string;
  enumLabel: string;
  typeCategory?: TypeCategory;
  elementTypeOid?: string;
}

// Aggregate rows from database types catalog into MappableTypes
export function reduceTypeRows(
  typeRows: TypeRow[],
): Record<string, MappableType> {
  const enumTypes = typeRows
    .filter((r) => r.typeKind === DatabaseTypeKind.Enum)
    .reduce((typeMap, { oid, typeName, enumLabel }) => {
      const typ = typeMap[oid] ?? typeName;

      // We should get one row per enum value
      return {
        ...typeMap,
        [oid]: {
          name: typeName,
          // Merge enum values
          enumValues: [...(isEnum(typ) ? typ.enumValues : []), enumLabel],
        },
      };
    }, {} as Record<string, MappableType>);
  return typeRows.reduce(
    (typeMap, { oid, typeName, typeCategory, elementTypeOid }) => {
      // Attempt to merge any partially defined types
      const typ = typeMap[oid] ?? typeName;

      if (oid in enumTypes) {
        return { ...typeMap, [oid]: enumTypes[oid] };
      }

      if (
        typeCategory === TypeCategory.ARRAY &&
        elementTypeOid &&
        elementTypeOid in enumTypes
      ) {
        return {
          ...typeMap,
          [oid]: {
            name: typeName,
            elementType: enumTypes[elementTypeOid],
          },
        };
      }

      return { ...typeMap, [oid]: typ };
    },
    {} as Record<string, MappableType>,
  );
}

// TODO: self-host
async function runTypesCatalogQuery(
  typeOIDs: number[],
  queue: AsyncQueue,
): Promise<TypeRow[]> {
  let rows: any[];
  if (typeOIDs.length > 0) {
    const concatenatedTypeOids = typeOIDs.join(',');
    rows = await runQuery(
      `
SELECT pt.oid, pt.typname, pt.typtype, pe.enumlabel, pt.typelem, pt.typcategory
FROM pg_type pt
LEFT JOIN pg_enum pe ON pt.oid = pe.enumtypid
WHERE pt.oid IN (${concatenatedTypeOids})
OR pt.oid IN (SELECT typelem FROM pg_type ptn WHERE ptn.oid IN (${concatenatedTypeOids}));
`,
      queue,
    );
  } else {
    rows = [];
  }
  return rows.map(
    ([oid, typeName, typeKind, enumLabel, elementTypeOid, typeCategory]) => ({
      oid,
      typeName,
      typeKind,
      enumLabel,
      elementTypeOid,
      typeCategory,
    }),
  );
}

interface ColumnComment {
  tableOID: number;
  columnAttrNumber: number;
  comment: string;
}

async function getComments(
  fields: TypeField[],
  queue: AsyncQueue,
): Promise<ColumnComment[]> {
  const columnFields = fields.filter((f) => f.columnAttrNumber > 0);
  if (columnFields.length === 0) {
    return [];
  }

  const matchers = columnFields.map(
    (f) => `(objoid=${f.tableOID} and objsubid=${f.columnAttrNumber})`,
  );
  const selection = matchers.join(' or ');

  const descriptionRows = await runQuery(
    `SELECT
      objoid, objsubid, description
     FROM pg_description WHERE ${selection};`,
    queue,
  );

  return descriptionRows.map((row) => ({
    tableOID: Number(row[0]),
    columnAttrNumber: Number(row[1]),
    comment: row[2],
  }));
}

const doTestRuns = true;
export async function getTypes(
  queryData: InterpolatedQuery,
  queue: AsyncQueue,
): Promise<IQueryTypes | IParseError> {
  const typeData = await getTypeData(queryData.query, queue);
  if ('errorCode' in typeData) {
    return typeData;
  }

  if (doTestRuns) {
    const testRunResult = await explainQuery(queryData.query, typeData, queue);
    if (testRunResult && 'errorCode' in testRunResult) {
      return testRunResult;
    }
  }

  const { params, fields } = typeData;

  const paramTypeOIDs = params.map((p) => p.oid);
  const returnTypesOIDs = fields.map((f) => f.typeOID);
  const usedTypesOIDs = paramTypeOIDs.concat(returnTypesOIDs);
  const typeRows = await runTypesCatalogQuery(usedTypesOIDs, queue);
  const commentRows = await getComments(fields, queue);
  const typeMap = reduceTypeRows(typeRows);

  const attrMatcher = ({
    tableOID,
    columnAttrNumber,
  }: {
    tableOID: number;
    columnAttrNumber: number;
  }) => `(attrelid = ${tableOID} and attnum = ${columnAttrNumber})`;

  const attrSelection =
    fields.length > 0 ? fields.map(attrMatcher).join(' or ') : false;

  const attributeRows = await runQuery(
    `SELECT
      (attrelid || ':' || attnum) AS attid, attname, attnotnull
     FROM pg_attribute WHERE ${attrSelection};`,
    queue,
  );
  const attrMap: {
    [attid: string]: {
      columnName: string;
      nullable: boolean;
    };
  } = attributeRows.reduce(
    (acc, [attid, attname, attnotnull]) => ({
      ...acc,
      [attid]: {
        columnName: attname,
        nullable: attnotnull !== 't',
      },
    }),
    {},
  );

  const getAttid = (col: Pick<TypeField, 'tableOID' | 'columnAttrNumber'>) =>
    `${col.tableOID}:${col.columnAttrNumber}`;

  const commentMap: { [attid: string]: string | undefined } = {};
  for (const c of commentRows) {
    commentMap[`${c.tableOID}:${c.columnAttrNumber}`] = c.comment;
  }

  const returnTypes = fields.map((f) => ({
    ...attrMap[getAttid(f)],
    ...(commentMap[getAttid(f)] ? { comment: commentMap[getAttid(f)] } : {}),
    returnName: f.name,
    type: typeMap[f.typeOID],
  }));

  const paramMetadata = {
    params: params.map(({ oid }) => typeMap[oid]),
    mapping: queryData.mapping,
  };

  return { paramMetadata, returnTypes };
}
