import { buildSiweMessage, verifySiwe, getNonceFromMessage } from "./siweAdapter";
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL || "http://127.0.0.1:8545");
const DOMAIN = "faucet.test";
const CHAIN_ID = 11155111;

describe("SIWE Adapter", () => {
  it("happy path EOA", async () => {
    const wallet = ethers.Wallet.createRandom();
    const msg = await buildSiweMessage({
      domain: DOMAIN,
      address: wallet.address,
      uri: "https://faucet.test",
      chainId: CHAIN_ID,
      statement: "Unit test",
      nonce: "abc123",
      issuedAt: new Date().toISOString()
    });
    const sig = await wallet.signMessage(msg);
    const nonce = getNonceFromMessage(msg)!;

    const res = await verifySiwe(provider, wallet.address, msg, sig, {
      domain: DOMAIN,
      chainId: CHAIN_ID,
      address: wallet.address.toLowerCase(),
      exactNonce: nonce
    }, "manual");
    expect(res.ok).toBe(true);
    expect(res.method).toBe("eoa");
  });

  it("fails with wrong domain", async () => {
    const wallet = ethers.Wallet.createRandom();
    const msg = await buildSiweMessage({
      domain: "evil.com",
      address: wallet.address,
      uri: "https://evil.com",
      chainId: CHAIN_ID,
      statement: "Unit test",
      nonce: "123",
      issuedAt: new Date().toISOString()
    });
    const sig = await wallet.signMessage(msg);

    const res = await verifySiwe(provider, wallet.address, msg, sig, {
      domain: DOMAIN,
      chainId: CHAIN_ID,
      address: wallet.address.toLowerCase()
    }, "manual");
    expect(res.ok).toBe(false);
  });
});
