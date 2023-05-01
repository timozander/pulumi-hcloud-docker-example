import * as pulumi from "@pulumi/pulumi";
import * as hcloud from "@pulumi/hcloud";
import * as tls from "@pulumi/tls";
import { remote, types } from "@pulumi/command";
import * as fs from "fs";

const config = new pulumi.Config();
const stack = pulumi.getStack();

// Get created IP adresses
let primaryIpv4 = null;
let primaryIpv6 = null;

if (config.getBoolean("create_ip")) {
  const ipConfig = {
    assigneeType: "server",
    datacenter: "nbg1-dc3",
    autoDelete: true,
  };
  primaryIpv4 = new hcloud.PrimaryIp(`${stack}-primary_ip-v4`, {
    ...ipConfig,
    type: "ipv4",
  });

  primaryIpv6 = new hcloud.PrimaryIp(`${stack}-primary_ip-v6`, {
    ...ipConfig,
    type: "ipv6",
  });
} else {
  primaryIpv4 = hcloud.getPrimaryIpOutput({
    name: `${stack}-primary_ip-v4`,
  });
  primaryIpv6 = hcloud.getPrimaryIpOutput({
    name: `${stack}-primary_ip-v6`,
  });
}

// Get all SSH keys that should be assigned to server
const standardSshKeys = await hcloud
  .getSshKeys({
    withSelector: "YOURPROJECT",
  })
  .then((allKeys) => allKeys.sshKeys);

// Create new SSH key to be used for deployment
const sshKey = new tls.PrivateKey("sshKey", {
  algorithm: "RSA",
  rsaBits: 4096,
});
const defaultSshKey = new hcloud.SshKey("default", {
  publicKey: sshKey.publicKeyOpenssh,
});

const dockerImage = await hcloud.getImage({
  name: "docker-ce",
  withArchitecture: "x86",
});

// Create server
const server = new hcloud.Server(stack, {
  location: "nbg1",
  image: `${dockerImage.id}`,
  name: `${stack}.haydn.app`,
  serverType: "cx11",
  publicNets: [
    {
      ipv4Enabled: true,
      // @ts-ignore
      ipv4: primaryIpv4.id,
      ipv6Enabled: true,
      // @ts-ignore
      ipv6: primaryIpv6.id,
    },
  ],
  sshKeys: [defaultSshKey.name, ...standardSshKeys.map((key) => key.name)],
});

const connection: types.input.remote.ConnectionArgs = {
  host: server.ipv6Address,
  user: "root",
  privateKey: sshKey.privateKeyPem,
};

// Copy docker-compose
const copyDockerCompose = new remote.CopyFile("Copy docker-compose.yml", {
  connection,
  localPath: `docker-compose.${stack}.yml`,
  remotePath: "docker-compose.yml",
});

// Login to Docker Registry
const dockerLoginCmd = config.requireSecret("github_pat").apply(
  (secret) =>
    `echo "${secret}" | 
      docker login ghcr.io -u YOURNAME --password-stdin`
);

const dockerLogin = new remote.Command("Docker Login", {
  connection,
  create: dockerLoginCmd,
});

// Install necessary software and pull container
new remote.Command(
  "Install Docker",
  {
    connection,
    create: [
      // Optional: Remove the file copying
      "mkdir -p user_conf.d",
      `echo '${fs
        .readFileSync("user_conf.d/app.conf")
        .toString()}' > user_conf.d/app.conf`,
      "apt-get update",
      "apt-get -y install docker-compose",
      "docker-compose pull",
    ].join(" && "),
  },
  {
    dependsOn: [dockerLogin, copyDockerCompose],
  }
);
