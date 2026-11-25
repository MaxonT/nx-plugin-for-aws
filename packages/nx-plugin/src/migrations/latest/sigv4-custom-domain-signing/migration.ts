/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  getProjects,
  joinPathFragments,
  type MigrationReturnObject,
  type Tree,
} from '@nx/devkit';
import { formatFilesInSubtree } from '../../../utils/format.js';
import {
  migrateVendedFiles,
  type VendedEdit,
} from '../../../utils/migrate-vended-text.js';
import { SIGV4_CUSTOM_DOMAINS } from '../../../utils/vended-shapes.js';

/**
 * The vended `useSigV4` hook let aws4fetch infer the service and region from a
 * request's hostname, which it cannot behind a custom domain, so API Gateway
 * refused the signature. It now names execute-api in the identity pool's region
 * for any host outside amazonaws.com.
 *
 * Guardrails: GritQL checks for the shape this hook was generated with, and
 * each edit matches its text, as a
 * formatter may have left it. A hook that has diverged is reported through
 * `nextSteps` and left alone, and a migrated hook no longer matches, so the
 * migration is idempotent.
 */
export const EDITS: VendedEdit[] = [
  {
    from: `  const sigv4Fetch: typeof globalThis.fetch = useCallback(`,
    to: `  // aws4fetch infers the service and region from an AWS hostname. Behind a custom
  // domain it can infer neither, so name API Gateway in the identity pool's region.
  const signingScope = useCallback(
    (input: RequestInfo | URL | AwsSignInput) => {
      const { hostname } = new URL(
        input instanceof Request ? input.url : input.toString(),
        window.location.href,
      );
      return !cognitoProps || hostname.endsWith('.amazonaws.com')
        ? {}
        : { service: 'execute-api', region: cognitoProps.region };
    },
    [cognitoProps],
  );

  const sigv4Fetch: typeof globalThis.fetch = useCallback(`,
  },
  {
    from: `      return awsClient.fetch(input, init);
    },
    [skipSigning, getAwsClient],`,
    to: `      return awsClient.fetch(input, { ...init, aws: signingScope(input) });
    },
    [skipSigning, getAwsClient, signingScope],`,
  },
  {
    from: `      return awsClient.sign(input, init);
    },
    [skipSigning, getAwsClient],`,
    to: `      return awsClient.sign(input, {
        ...init,
        aws: { ...signingScope(input), ...init?.aws },
      });
    },
    [skipSigning, getAwsClient, signingScope],`,
  },
];

export default async function migration(
  tree: Tree,
): Promise<MigrationReturnObject> {
  const paths = [...getProjects(tree).values()].map((project) =>
    joinPathFragments(
      project.sourceRoot ?? joinPathFragments(project.root, 'src'),
      'hooks',
      'useSigV4.tsx',
    ),
  );
  const { nextSteps } = await migrateVendedFiles(
    tree,
    paths,
    SIGV4_CUSTOM_DOMAINS,
    EDITS,
    (path) =>
      `${path} has changed since it was generated, so it was left alone. To sign calls behind a custom domain, pass { service: 'execute-api', region } to aws4fetch for hosts outside amazonaws.com.`,
  );
  await formatFilesInSubtree(tree);
  return { nextSteps };
}
