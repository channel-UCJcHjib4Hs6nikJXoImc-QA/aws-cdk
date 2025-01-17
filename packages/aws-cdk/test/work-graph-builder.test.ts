import * as fs from 'fs';
import * as path from 'path';
import * as cxschema from '@aws-cdk/cloud-assembly-schema';
import * as cxapi from '@aws-cdk/cx-api';
import { CloudAssemblyBuilder } from '@aws-cdk/cx-api';
import { WorkGraphBuilder } from '../lib/util/work-graph-builder';
import { AssetBuildNode, AssetPublishNode, StackNode, WorkNode } from '../lib/util/work-graph-types';

let rootBuilder: CloudAssemblyBuilder;
beforeEach(() => {
  rootBuilder = new CloudAssemblyBuilder();
});

afterEach(() => {
  rootBuilder.delete();
});

describe('with some stacks and assets', () => {
  let assembly: cxapi.CloudAssembly;
  beforeEach(() => {
    addSomeStacksAndAssets(rootBuilder);
    assembly = rootBuilder.buildAssembly();
  });

  test('stack depends on the asset publishing step', () => {
    const graph = new WorkGraphBuilder(true).build(assembly.artifacts);

    expect(assertableNode(graph.node('stack2'))).toEqual(expect.objectContaining({
      type: 'stack',
      dependencies: expect.arrayContaining(['F1:D1-publish']),
    } as StackNode));
  });

  test('asset publishing step depends on asset building step', () => {
    const graph = new WorkGraphBuilder(true).build(assembly.artifacts);

    expect(graph.node('F1:D1-publish')).toEqual(expect.objectContaining({
      type: 'asset-publish',
      dependencies: new Set(['F1:D1-build']),
    } as Partial<AssetPublishNode>));
  });

  test('with prebuild off, asset building inherits dependencies from their parent stack', () => {
    const graph = new WorkGraphBuilder(false).build(assembly.artifacts);

    expect(graph.node('F1:D1-build')).toEqual(expect.objectContaining({
      type: 'asset-build',
      dependencies: new Set(['stack0', 'stack1']),
    } as Partial<AssetBuildNode>));
  });

  test('with prebuild on, assets only have their own dependencies', () => {
    const graph = new WorkGraphBuilder(true).build(assembly.artifacts);

    expect(graph.node('F1:D1-build')).toEqual(expect.objectContaining({
      type: 'asset-build',
      dependencies: new Set(['stack0']),
    } as Partial<AssetBuildNode>));
  });
});

test('tree metadata is ignored', async () => {
  rootBuilder.addArtifact('tree', {
    type: cxschema.ArtifactType.CDK_TREE,
    properties: {
      file: 'doesnotexist.json',
    } as cxschema.TreeArtifactProperties,
  });

  const assembly = rootBuilder.buildAssembly();

  const graph = new WorkGraphBuilder(true).build(assembly.artifacts);
  expect(graph.ready().length).toEqual(0);
});

test('can handle nested assemblies', async () => {
  addSomeStacksAndAssets(rootBuilder);
  const nested = rootBuilder.createNestedAssembly('nested', 'Nested Assembly');
  addSomeStacksAndAssets(nested);
  nested.buildAssembly();

  const assembly = rootBuilder.buildAssembly();

  let workDone = 0;
  const graph = new WorkGraphBuilder(true).build(assembly.artifacts);
  await graph.doParallel(10, {
    deployStack: async () => { workDone += 1; },
    buildAsset: async () => { },
    publishAsset: async () => { workDone += 1; },
  });

  expect(workDone).toEqual(8);
});

test('dependencies on unselected artifacts are silently ignored', async () => {
  addStack(rootBuilder, 'stackA', {
    environment: 'aws://222222/us-east-1',
  });
  addStack(rootBuilder, 'stackB', {
    dependencies: ['stackA'],
    environment: 'aws://222222/us-east-1',
  });

  const asm = rootBuilder.buildAssembly();
  const graph = new WorkGraphBuilder(true).build([asm.getStackArtifact('stackB')]);
  expect(graph.ready()[0]).toEqual(expect.objectContaining({
    id: 'stackB',
    dependencies: new Set(),
  }));
});

/**
 * Write an asset manifest file and add it to the assembly builder
 */
function addAssets(
  builder: CloudAssemblyBuilder,
  artifactId: string,
  options: { files: Record<string, cxschema.FileAsset>, dependencies?: string[] },
) {
  const manifestFile = `${artifactId}.json`;
  const outPath = path.join(builder.outdir, manifestFile);

  const manifest: cxschema.AssetManifest = {
    version: cxschema.Manifest.version(),
    files: options.files,
  };

  fs.writeFileSync(outPath, JSON.stringify(manifest, undefined, 2));

  builder.addArtifact(artifactId, {
    type: cxschema.ArtifactType.ASSET_MANIFEST,
    dependencies: options.dependencies,
    properties: {
      file: manifestFile,
    } as cxschema.AssetManifestProperties,
  });
}

/**
 * Add a stack to the cloud assembly
 */
function addStack(builder: CloudAssemblyBuilder, stackId: string, options: { environment: string, dependencies?: string[] }) {
  const templateFile = `${stackId}.template.json`;
  const outPath = path.join(builder.outdir, templateFile);
  fs.writeFileSync(outPath, JSON.stringify({}, undefined, 2));

  builder.addArtifact(stackId, {
    type: cxschema.ArtifactType.AWS_CLOUDFORMATION_STACK,
    dependencies: options.dependencies,
    environment: options.environment,
    properties: {
      templateFile,
    },
  });
}

function addSomeStacksAndAssets(builder: CloudAssemblyBuilder) {
  addStack(builder, 'stack0', {
    environment: 'aws://11111/us-east-1',
  });
  addAssets(builder, 'stack2assets', {
    dependencies: ['stack0'],
    files: {
      F1: {
        source: { path: 'xyz' },
        destinations: {
          D1: { bucketName: 'bucket', objectKey: 'key' },
        },
      },
    },
  });
  addStack(builder, 'stack1', {
    environment: 'aws://11111/us-east-1',
  });
  addStack(builder, 'stack2', {
    environment: 'aws://11111/us-east-1',
    dependencies: ['stack2assets', 'stack1'],
  });
}

/**
 * We can't do arrayContaining on the set that a Node has, so convert it to an array for asserting
 */
function assertableNode<A extends WorkNode>(x: A) {
  return {
    ...x,
    dependencies: Array.from(x.dependencies),
  };
}