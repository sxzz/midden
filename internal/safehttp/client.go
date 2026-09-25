// Package safehttp pins validated public DNS results at dial time, including redirects.
package safehttp

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"time"
)

var denied = []string{"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "::/96", "::ffff:0:0/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/23", "2002::/16", "fc00::/7", "fe80::/10", "ff00::/8"}

func Public(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, s := range denied {
		if netip.MustParsePrefix(s).Contains(ip) {
			return false
		}
	}
	return true
}

func New(timeout time.Duration) *http.Client {
	tr := &http.Transport{MaxIdleConns: 32, MaxIdleConnsPerHost: 8, IdleConnTimeout: 90 * time.Second, ResponseHeaderTimeout: 20 * time.Second, TLSHandshakeTimeout: 10 * time.Second}
	tr.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, e := net.SplitHostPort(address)
		if e != nil {
			return nil, e
		}
		if port != "80" && port != "443" {
			return nil, fmt.Errorf("disallowed port")
		}
		ips, e := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if e != nil {
			return nil, fmt.Errorf("DNS lookup failed")
		}
		for _, ip := range ips {
			if !Public(ip) {
				return nil, fmt.Errorf("non-public destination")
			}
		}
		for _, ip := range ips {
			c, err := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if err == nil {
				return c, nil
			}
		}
		return nil, fmt.Errorf("connection failed")
	}
	return &http.Client{Transport: tr, Timeout: timeout, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("too many redirects")
		}
		if r.URL.Scheme != "http" && r.URL.Scheme != "https" {
			return fmt.Errorf("unsupported scheme")
		}
		if r.URL.User != nil {
			return fmt.Errorf("URL credentials forbidden")
		}
		return nil
	}}
}
