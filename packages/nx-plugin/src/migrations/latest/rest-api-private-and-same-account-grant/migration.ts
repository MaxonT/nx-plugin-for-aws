/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  joinPathFragments,
  type MigrationReturnObject,
  type Tree,
} from '@nx/devkit';
import { addDestructuredImport } from '../../../utils/ast.js';
import { formatFilesInSubtree } from '../../../utils/format.js';
import {
  migrateVendedFiles,
  type VendedEdit,
} from '../../../utils/migrate-vended-text.js';
import {
  PACKAGES_DIR,
  SHARED_CONSTRUCTS_DIR,
} from '../../../utils/shared-constructs-constants.js';
import {
  REST_API_PRIVATE_PROPS,
  REST_API_SAME_ACCOUNT_GRANT,
} from '../../../utils/vended-shapes.js';

/**
 * A vended REST API construct accepted only its integrations and enableWaf,
 * so it could not be made private, and its grantInvokeAccess named the grantee
 * in the API's resource policy as well as in the grantee's own policy. With a
 * callback URL naming the API, that made a dependency cycle. It now accepts an
 * endpoint configuration and resource policy, and names a grantee in the
 * resource policy only when it is in another account.
 *
 * Guardrails: GritQL checks for the shape this construct was generated with,
 * and the edits match its text, as a formatter may have left it. A construct that has diverged is reported through
 * `nextSteps` and left alone, and a migrated one no longer matches, so the
 * migration is idempotent. Only REST API constructs are touched: the props edit
 * needs the REST construct's enableWaf, and the grant edit its resource policy.
 */
export const PROPS_EDITS: VendedEdit[] = [
  {
    from: `  LambdaIntegration,
`,
    to: `  LambdaIntegration,
  RestApiProps,
`,
  },
  {
    from: `  enableWaf?: boolean;
}`,
    to: `  enableWaf?: boolean;
  /**
   * The API's endpoint type, for example PRIVATE with the VPC endpoints that may reach it.
   *
   * @default a regional endpoint
   */
  endpointConfiguration?: RestApiProps['endpointConfiguration'];
  /**
   * A resource policy that replaces the default one, for example to admit only calls
   * through a VPC endpoint.
   */
  policy?: RestApiProps['policy'];
}`,
  },
];

export const GRANT_EDITS: VendedEdit[] = [
  {
    from: `import { Aspects, Duration } from 'aws-cdk-lib';`,
    to: `import {
  Aspects,
  Duration,
  Stack,
  Token,
  TokenComparison,
} from 'aws-cdk-lib';`,
    optional: true,
  },
  {
    from: `import { Aspects, Duration, Stack } from 'aws-cdk-lib';`,
    to: `import {
  Aspects,
  Duration,
  Stack,
  Token,
  TokenComparison,
} from 'aws-cdk-lib';`,
    optional: true,
  },
  {
    from: `    this.api.addToResourcePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        principals: [grantee.grantPrincipal],
        actions: ['execute-api:Invoke'],
        resources: ['execute-api:/*'],
      }),
    );

    Grant.addToPrincipal({
      grantee,
      actions: ['execute-api:Invoke'],
      resourceArns: [this.api.arnForExecuteApi('*', '/*', '*')],
    });`,
    to: `    Grant.addToPrincipal({
      grantee,
      actions: ['execute-api:Invoke'],
      resourceArns: [this.api.arnForExecuteApi('*', '/*', '*')],
    });

    // The principal's own policy is enough within this account, as CDK's grants assume for
    // two unresolved accounts. A principal in another account also needs the resource policy.
    const { principalAccount } = grantee.grantPrincipal;
    const accounts = principalAccount
      ? Token.compareStrings(principalAccount, Stack.of(this).account)
      : undefined;
    if (
      accounts !== TokenComparison.SAME &&
      accounts !== TokenComparison.BOTH_UNRESOLVED
    ) {
      this.api.addToResourcePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          principals: [grantee.grantPrincipal],
          actions: ['execute-api:Invoke'],
          resources: ['execute-api:/*'],
        }),
      );
    }`,
  },
];

export default async function migration(
  tree: Tree,
): Promise<MigrationReturnObject> {
  const apisDir = joinPathFragments(
    PACKAGES_DIR,
    SHARED_CONSTRUCTS_DIR,
    'src',
    'app',
    'apis',
  );
  const restApis = tree.exists(apisDir)
    ? tree
        .children(apisDir)
        .map((file) => joinPathFragments(apisDir, file))
        .filter((path) =>
          /from '\.\.\/\.\.\/core\/api\/rest-api(\.js)?'/.test(
            tree.read(path, 'utf-8') ?? '',
          ),
        )
    : [];
  const diverged = (path: string) =>
    `${path} has changed since it was generated, so it was left alone. To put it behind a Verified Access door it needs endpointConfiguration and policy props, and its grantInvokeAccess should name a same-account grantee only in the grantee's own policy.`;

  // A construct is migrated whole or not at all
  const isIam = (path: string) =>
    (tree.read(path, 'utf-8') ?? '').includes('grantInvokeAccess(');
  const iam = await migrateVendedFiles(
    tree,
    restApis.filter(isIam),
    {
      current: REST_API_SAME_ACCOUNT_GRANT.current,
      old: [...REST_API_PRIVATE_PROPS.old, ...REST_API_SAME_ACCOUNT_GRANT.old],
    },
    [...PROPS_EDITS, ...GRANT_EDITS],
    diverged,
  );
  const other = await migrateVendedFiles(
    tree,
    restApis.filter((path) => !isIam(path)),
    REST_API_PRIVATE_PROPS,
    PROPS_EDITS,
    diverged,
  );
  // An import the edits could not place, as in a file whose imports were
  // rearranged, is added where the import helper puts it
  for (const path of [...iam.migrated, ...other.migrated]) {
    await addDestructuredImport(
      tree,
      path,
      ['RestApiProps'],
      'aws-cdk-lib/aws-apigateway',
    );
  }
  for (const path of iam.migrated) {
    await addDestructuredImport(
      tree,
      path,
      ['Stack', 'Token', 'TokenComparison'],
      'aws-cdk-lib',
    );
  }
  await formatFilesInSubtree(tree);
  return { nextSteps: [...iam.nextSteps, ...other.nextSteps] };
}
